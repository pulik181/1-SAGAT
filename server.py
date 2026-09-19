#!/usr/bin/env python3
"""
server.py — бэкенд MVP платформы 1 SAGAT.

FastAPI + SQLite. Реальная регистрация и вход, роли (кандидат / компания),
вакансии с контуром отбора, сессии симуляции с серверным таймером,
детерминированная оценка по JSON-рубрикатору, публичные Verified Skill Badge,
shortlist для HR и выгрузка в CSV.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import engine

# База лежит вне каталога сайта: файлы каталога раздаются статикой, БД туда попадать не должна.
DATA_DIR = os.environ.get("SAGAT_DATA_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sagat-data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "sagat.db")
SESSION_TTL = 60 * 60 * 24 * 30  # 30 дней
SIM_LIMIT_SEC = 60 * 60  # 60 минут на симуляцию
MIN_ANSWER_CHARS = 180

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")


def now() -> int:
    return int(time.time())


def iso(ts: int | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────────────
# Схема
# ─────────────────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  org TEXT,
  city TEXT,
  pass_hash TEXT NOT NULL,
  is_demo INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  visitor_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vacancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  role_key TEXT NOT NULL,
  city TEXT,
  stack TEXT,
  budget INTEGER,
  days INTEGER,
  threshold INTEGER DEFAULT 65,
  applicants INTEGER DEFAULT 0,
  inject_on INTEGER DEFAULT 1,
  local_data INTEGER DEFAULT 1,
  code TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  vacancy_id INTEGER,
  mode TEXT NOT NULL,
  role_key TEXT NOT NULL,
  case_key TEXT NOT NULL,
  case_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  inject_at INTEGER,
  submitted_at INTEGER,
  finished_at INTEGER,
  answer TEXT DEFAULT '',
  inject_offset INTEGER DEFAULT 0,
  questions_json TEXT,
  defense_json TEXT,
  telemetry_json TEXT,
  scores_json TEXT,
  total INTEGER,
  badge TEXT,
  badge_pid TEXT,
  hr_status TEXT DEFAULT 'new',
  hr_note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_att_vac ON attempts(vacancy_id);
"""
db.executescript(SCHEMA)
db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Пароли и сессии
# ─────────────────────────────────────────────────────────────────────────────


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000)
    return f"pbkdf2$120000${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iters))
        return hmac.compare_digest(dk.hex(), digest)
    except Exception:
        return False


def new_session(user_id: int, visitor_id: str | None) -> str:
    token = secrets.token_urlsafe(28)
    db.execute(
        "INSERT INTO sessions (token, user_id, visitor_id, created_at, last_seen) VALUES (?,?,?,?,?)",
        (token, user_id, visitor_id, now(), now()),
    )
    db.commit()
    return token


def user_public(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "org": row["org"] or "",
        "city": row["city"] or "",
        "created_at": iso(row["created_at"]),
    }


def get_user(uid: int) -> sqlite3.Row | None:
    return db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


async def current_user(
    authorization: str | None = Header(default=None),
    x_visitor_id: str | None = Header(default=None),
) -> sqlite3.Row | None:
    """Токен из заголовка; если браузер в песочнице (нет storage) — по visitor-id."""
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    row = None
    if token:
        row = db.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
    if row is None and x_visitor_id:
        row = db.execute(
            "SELECT * FROM sessions WHERE visitor_id=? ORDER BY last_seen DESC LIMIT 1",
            (x_visitor_id,),
        ).fetchone()
    if row is None:
        return None
    if now() - row["created_at"] > SESSION_TTL:
        db.execute("DELETE FROM sessions WHERE token=?", (row["token"],))
        db.commit()
        return None
    db.execute("UPDATE sessions SET last_seen=? WHERE token=?", (now(), row["token"]))
    db.commit()
    return get_user(row["user_id"])


def require(user: sqlite3.Row | None, role: str | None = None) -> sqlite3.Row:
    if user is None:
        raise HTTPException(401, "Требуется вход в аккаунт")
    if role and user["role"] != role:
        raise HTTPException(403, "Недостаточно прав для этого действия")
    return user


# ─────────────────────────────────────────────────────────────────────────────
# Приложение
# ─────────────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_demo()
    yield
    db.close()


app = FastAPI(title="1 SAGAT API", version="2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$")


class SignUp(BaseModel):
    email: str
    password: str
    name: str
    role: str = "candidate"
    org: str | None = ""
    city: str | None = ""


class SignIn(BaseModel):
    email: str
    password: str


class ProfilePatch(BaseModel):
    name: str | None = None
    org: str | None = None
    city: str | None = None


class VacancyIn(BaseModel):
    title: str
    role_key: str
    city: str | None = "Алматы"
    stack: str | None = ""
    budget: int = 300
    days: int = 10
    threshold: int = 65
    applicants: int = 0
    inject_on: bool = True
    local_data: bool = True


class AttemptStart(BaseModel):
    mode: str = "career"  # career | hiring
    role_key: str | None = None
    code: str | None = None


class SubmitIn(BaseModel):
    answer: str
    telemetry: dict[str, Any] = Field(default_factory=dict)


class FinishIn(BaseModel):
    defense: list[str] = Field(default_factory=list)
    telemetry: dict[str, Any] = Field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Аутентификация
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/health")
def health():
    return {"ok": True, "rubric": engine.RUBRIC_VERSION, "time": iso(now())}


@app.post("/api/auth/signup")
def signup(payload: SignUp, x_visitor_id: str | None = Header(default=None)):
    email = payload.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Введите корректный email")
    if len(payload.password) < 8:
        raise HTTPException(400, "Пароль должен быть не короче 8 символов")
    if len(payload.name.strip()) < 2:
        raise HTTPException(400, "Укажите имя и фамилию")
    if payload.role not in ("candidate", "company"):
        raise HTTPException(400, "Неизвестная роль аккаунта")
    if payload.role == "company" and not (payload.org or "").strip():
        raise HTTPException(400, "Для компании укажите название организации")
    if db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        raise HTTPException(409, "Аккаунт с этим email уже существует — войдите")
    cur = db.execute(
        "INSERT INTO users (email, name, role, org, city, pass_hash, created_at) VALUES (?,?,?,?,?,?,?)",
        (
            email,
            payload.name.strip(),
            payload.role,
            (payload.org or "").strip() or ("Самостоятельно" if payload.role == "candidate" else ""),
            (payload.city or "").strip(),
            hash_password(payload.password),
            now(),
        ),
    )
    db.commit()
    user = get_user(cur.lastrowid)
    token = new_session(user["id"], x_visitor_id)
    return {"token": token, "user": user_public(user)}


@app.post("/api/auth/login")
def login(payload: SignIn, x_visitor_id: str | None = Header(default=None)):
    email = payload.email.strip().lower()
    user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not user or not verify_password(payload.password, user["pass_hash"]):
        raise HTTPException(401, "Неверный email или пароль")
    token = new_session(user["id"], x_visitor_id)
    return {"token": token, "user": user_public(user)}


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None), x_visitor_id: str | None = Header(default=None)):
    if authorization and authorization.lower().startswith("bearer "):
        db.execute("DELETE FROM sessions WHERE token=?", (authorization[7:].strip(),))
    if x_visitor_id:
        db.execute("DELETE FROM sessions WHERE visitor_id=?", (x_visitor_id,))
    db.commit()
    return {"ok": True}


@app.get("/api/me")
def me(user: sqlite3.Row | None = Depends(current_user)):
    if user is None:
        return {"user": None}
    return {"user": user_public(user), "stats": user_stats(user)}


@app.patch("/api/me")
def patch_me(payload: ProfilePatch, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user)
    name = (payload.name or u["name"]).strip()
    if len(name) < 2:
        raise HTTPException(400, "Имя слишком короткое")
    db.execute(
        "UPDATE users SET name=?, org=?, city=? WHERE id=?",
        (name, (payload.org if payload.org is not None else u["org"]), (payload.city if payload.city is not None else u["city"]), u["id"]),
    )
    db.commit()
    return {"user": user_public(get_user(u["id"]))}


# ─────────────────────────────────────────────────────────────────────────────
# Каталог
# ─────────────────────────────────────────────────────────────────────────────


@app.get("/api/catalog")
def catalog():
    return {
        "roles": [
            {
                "key": r["key"],
                "title": r["title"],
                "short": r["short"],
                "stack": r["default_stack"],
                "skills": r["skills"],
                "cases": len(engine.cases_for_role(k)),
            }
            for k, r in engine.ROLES.items()
        ],
        "rubric": {
            "version": engine.RUBRIC_VERSION,
            "weights": engine.WEIGHTS,
            "titles": engine.CRIT_TITLES,
            "penalty_max": engine.PENALTY_MAX,
        },
        "duration_min": 60,
        "min_chars": MIN_ANSWER_CHARS,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Статистика кандидата
# ─────────────────────────────────────────────────────────────────────────────


def user_stats(user: sqlite3.Row) -> dict[str, Any]:
    if user["role"] == "company":
        vacs = db.execute("SELECT id, threshold FROM vacancies WHERE owner_id=?", (user["id"],)).fetchall()
        ids = [v["id"] for v in vacs]
        done = shortlisted = 0
        if ids:
            q = ",".join("?" * len(ids))
            rows = db.execute(
                f"SELECT total, vacancy_id FROM attempts WHERE vacancy_id IN ({q}) AND status='scored'", ids
            ).fetchall()
            thr = {v["id"]: v["threshold"] for v in vacs}
            done = len(rows)
            shortlisted = sum(1 for r in rows if (r["total"] or 0) >= thr.get(r["vacancy_id"], 65))
        return {
            "vacancies": len(vacs),
            "completed": done,
            "shortlisted": shortlisted,
            "hours_saved": round(done * 0.55, 1),
        }

    rows = db.execute(
        "SELECT total, badge, role_key, scores_json FROM attempts WHERE user_id=? AND status='scored' ORDER BY id",
        (user["id"],),
    ).fetchall()
    totals = [r["total"] or 0 for r in rows]
    badges = sum(1 for r in rows if r["badge"] == "verified")
    crit: dict[str, list[float]] = {}
    for r in rows:
        try:
            sc = json.loads(r["scores_json"] or "{}")
        except Exception:
            continue
        for c in sc.get("criteria", []):
            crit.setdefault(c["key"], []).append(round(c["score"] / c["max"] * 100))
    radar = {k: round(sum(v) / len(v)) for k, v in crit.items() if v}
    return {
        "attempts": len(rows),
        "best": max(totals) if totals else 0,
        "avg": round(sum(totals) / len(totals)) if totals else 0,
        "badges": badges,
        "trend": totals[-6:],
        "radar": radar,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Вакансии
# ─────────────────────────────────────────────────────────────────────────────


def vac_public(v: sqlite3.Row, with_counts: bool = True) -> dict[str, Any]:
    out = {
        "id": v["id"],
        "title": v["title"],
        "role_key": v["role_key"],
        "role_title": engine.ROLES.get(v["role_key"], {}).get("title", v["role_key"]),
        "city": v["city"],
        "stack": v["stack"],
        "budget": v["budget"],
        "days": v["days"],
        "threshold": v["threshold"],
        "applicants": v["applicants"],
        "inject_on": bool(v["inject_on"]),
        "local_data": bool(v["local_data"]),
        "code": v["code"],
        "status": v["status"],
        "created_at": iso(v["created_at"]),
    }
    if with_counts:
        rows = db.execute(
            "SELECT total, status FROM attempts WHERE vacancy_id=?", (v["id"],)
        ).fetchall()
        done = [r for r in rows if r["status"] == "scored"]
        out["stats"] = {
            "started": len(rows),
            "completed": len(done),
            "shortlist": sum(1 for r in done if (r["total"] or 0) >= v["threshold"]),
            "hours_saved": round(len(done) * 0.55, 1),
            "avg": round(sum((r["total"] or 0) for r in done) / len(done)) if done else 0,
        }
    return out


@app.get("/api/vacancies")
def list_vacancies(user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "company")
    rows = db.execute("SELECT * FROM vacancies WHERE owner_id=? ORDER BY id DESC", (u["id"],)).fetchall()
    return {"vacancies": [vac_public(v) for v in rows]}


@app.post("/api/vacancies")
def create_vacancy(payload: VacancyIn, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "company")
    if payload.role_key not in engine.ROLES:
        raise HTTPException(400, "Неизвестная роль")
    if not payload.title.strip():
        raise HTTPException(400, "Укажите название вакансии")
    code = "SG-" + secrets.token_hex(3).upper()
    cur = db.execute(
        """INSERT INTO vacancies (owner_id,title,role_key,city,stack,budget,days,threshold,applicants,
           inject_on,local_data,code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            u["id"], payload.title.strip(), payload.role_key, (payload.city or "").strip(),
            (payload.stack or engine.ROLES[payload.role_key]["default_stack"]).strip(),
            int(payload.budget), int(payload.days), int(payload.threshold), int(payload.applicants or 0),
            1 if payload.inject_on else 0, 1 if payload.local_data else 0, code, now(),
        ),
    )
    db.commit()
    v = db.execute("SELECT * FROM vacancies WHERE id=?", (cur.lastrowid,)).fetchone()
    preview = engine.build_case(v["role_key"], 0, dict(v))
    return {"vacancy": vac_public(v), "case_preview": preview}


@app.get("/api/vacancies/{vid}")
def vacancy_detail(vid: int, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "company")
    v = db.execute("SELECT * FROM vacancies WHERE id=? AND owner_id=?", (vid, u["id"])).fetchone()
    if not v:
        raise HTTPException(404, "Вакансия не найдена")
    rows = db.execute(
        """SELECT a.*, us.name AS cand_name, us.email AS cand_email, us.city AS cand_city
           FROM attempts a JOIN users us ON us.id = a.user_id
           WHERE a.vacancy_id=? AND a.status='scored' ORDER BY a.total DESC""",
        (vid,),
    ).fetchall()
    cards = [candidate_card(r, v["threshold"]) for r in rows]
    return {
        "vacancy": vac_public(v),
        "case_preview": engine.build_case(v["role_key"], 0, dict(v)),
        "candidates": cards,
        "analytics": vacancy_analytics(cards, v["threshold"]),
    }


def vacancy_analytics(cards: list[dict[str, Any]], threshold: int) -> dict[str, Any]:
    """Сводка по отбору: где кандидаты сильны и где проваливаются.

    Считается детерминированно, по тем же баллам рубрикатора, что видит HR в строках."""
    n = len(cards)
    if not n:
        return {"count": 0, "criteria": [], "statuses": {}, "avg_total": 0, "weakest": None}
    order = ["logic", "tech", "constraints", "adaptivity", "defense"]
    titles: dict[str, str] = {}
    acc: dict[str, list[float]] = {k: [] for k in order}
    for c in cards:
        for x in c.get("criteria", []):
            k = x.get("key")
            if k in acc and x.get("max"):
                acc[k].append(100.0 * float(x["score"]) / float(x["max"]))
                titles[k] = x.get("title", k)
    crit = []
    for k in order:
        vals = acc.get(k) or []
        if not vals:
            continue
        crit.append({
            "key": k,
            "title": titles.get(k, k),
            "avg": round(sum(vals) / len(vals), 1),
            "best": round(max(vals)),
            "passed": sum(1 for x in vals if x >= 60),
        })
    statuses: dict[str, int] = {}
    for c in cards:
        st = c.get("hr_status") or "new"
        statuses[st] = statuses.get(st, 0) + 1
    totals = sorted(c["total"] for c in cards)
    weakest = min(crit, key=lambda x: x["avg"]) if crit else None
    return {
        "count": n,
        "criteria": crit,
        "statuses": statuses,
        "avg_total": round(sum(totals) / n, 1),
        "median_total": totals[n // 2],
        "threshold": threshold,
        "above_threshold": sum(1 for c in cards if c["total"] >= threshold),
        "flagged": sum(1 for c in cards if (c.get("flags") or [])),
        "with_badge": sum(1 for c in cards if c.get("badge") == "verified"),
        "weakest": weakest,
        "notes": sum(1 for c in cards if (c.get("hr_note") or "").strip()),
    }


@app.delete("/api/vacancies/{vid}")
def close_vacancy(vid: int, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "company")
    db.execute("UPDATE vacancies SET status='closed' WHERE id=? AND owner_id=?", (vid, u["id"]))
    db.commit()
    return {"ok": True}


@app.patch("/api/attempts/{aid}/hr")
def set_hr_status(
    aid: int,
    body: dict[str, Any] = Body(...),
    user: sqlite3.Row | None = Depends(current_user),
):
    u = require(user, "company")
    row = db.execute(
        """SELECT a.id FROM attempts a JOIN vacancies v ON v.id=a.vacancy_id
           WHERE a.id=? AND v.owner_id=?""",
        (aid, u["id"]),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Кандидат не найден в ваших отборах")
    out: dict[str, Any] = {"ok": True}
    if "hr_status" in body:
        status = body.get("hr_status") or "new"
        if status not in ("new", "shortlist", "interview", "offer", "reject"):
            raise HTTPException(400, "Неизвестный статус")
        db.execute("UPDATE attempts SET hr_status=? WHERE id=?", (status, aid))
        out["hr_status"] = status
    if "hr_note" in body:
        note = str(body.get("hr_note") or "")[:2000]
        db.execute("UPDATE attempts SET hr_note=? WHERE id=?", (note, aid))
        out["hr_note"] = note
    db.commit()
    return out


def candidate_card(a: sqlite3.Row, threshold: int) -> dict[str, Any]:
    try:
        sc = json.loads(a["scores_json"] or "{}")
    except Exception:
        sc = {}
    tele = sc.get("telemetry", {})
    return {
        "attempt_id": a["id"],
        "name": a["cand_name"] if "cand_name" in a.keys() else "",
        "email": a["cand_email"] if "cand_email" in a.keys() else "",
        "city": (a["cand_city"] if "cand_city" in a.keys() else "") or "",
        "total": a["total"] or 0,
        "badge": a["badge"],
        "in_shortlist": (a["total"] or 0) >= threshold,
        "hr_status": a["hr_status"],
        "hr_note": a["hr_note"] or "",
        "criteria": sc.get("criteria", []),
        "flags": sc.get("flags", []),
        "verdict": sc.get("verdict", ""),
        "strengths": sc.get("strengths", []),
        "gaps": sc.get("gaps", []),
        "telemetry": tele,
        "answer": a["answer"] or "",
        "defense": json.loads(a["defense_json"] or "[]"),
        "questions": json.loads(a["questions_json"] or "[]"),
        "case_title": (json.loads(a["case_json"] or "{}") or {}).get("title", ""),
        "minutes": round(((a["finished_at"] or a["started_at"]) - a["started_at"]) / 60, 1),
        "finished_at": iso(a["finished_at"]),
        "badge_pid": a["badge_pid"],
    }


HR_STATUS_RU = {
    "new": "новый",
    "shortlist": "в shortlist",
    "interview": "интервью",
    "offer": "оффер",
    "reject": "отказ",
}


@app.get("/api/vacancies/{vid}/export.csv")
def export_csv(vid: int, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "company")
    v = db.execute("SELECT * FROM vacancies WHERE id=? AND owner_id=?", (vid, u["id"])).fetchone()
    if not v:
        raise HTTPException(404, "Вакансия не найдена")
    rows = db.execute(
        """SELECT a.*, us.name AS cand_name, us.email AS cand_email, us.city AS cand_city
           FROM attempts a JOIN users us ON us.id=a.user_id
           WHERE a.vacancy_id=? AND a.status='scored' ORDER BY a.total DESC""",
        (vid,),
    ).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Кандидат", "Email", "Город", "Балл", "Бейдж", "В shortlist", "Статус HR",
                "Логика", "Техника", "Ограничения", "Адаптивность", "Защита", "Флаги", "Минут", "Заметка HR", "Бейдж-ссылка"])
    for r in rows:
        c = candidate_card(r, v["threshold"])
        by = {x["key"]: x["score"] for x in c["criteria"]}
        w.writerow([
            c["name"], c["email"], c["city"], c["total"], c["badge"], "да" if c["in_shortlist"] else "нет",
            HR_STATUS_RU.get(c["hr_status"], c["hr_status"]), by.get("logic", ""), by.get("tech", ""), by.get("constraints", ""),
            by.get("adaptivity", ""), by.get("defense", ""), " | ".join(c["flags"]), c["minutes"],
            (c.get("hr_note") or "").replace("\n", " "),
            f"#/badge/{c['badge_pid']}" if c["badge_pid"] else "",
        ])
    data = "\ufeff" + buf.getvalue()
    return StreamingResponse(
        io.BytesIO(data.encode("utf-8")),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="shortlist-{vid}.csv"'},
    )


@app.get("/api/vacancy-by-code/{code}")
def vacancy_by_code(code: str):
    v = db.execute("SELECT * FROM vacancies WHERE code=?", (code.strip().upper(),)).fetchone()
    if not v:
        raise HTTPException(404, "Отбор с таким кодом не найден")
    owner = get_user(v["owner_id"])
    return {
        "vacancy": {
            "id": v["id"], "title": v["title"], "role_title": engine.ROLES[v["role_key"]]["title"],
            "city": v["city"], "stack": v["stack"], "code": v["code"], "status": v["status"],
            "company": owner["org"] if owner else "",
        }
    }


# ─────────────────────────────────────────────────────────────────────────────
# Симуляция
# ─────────────────────────────────────────────────────────────────────────────


def attempt_public(a: sqlite3.Row, include_case: bool = True) -> dict[str, Any]:
    out = {
        "id": a["id"],
        "mode": a["mode"],
        "role_key": a["role_key"],
        "role_title": engine.ROLES.get(a["role_key"], {}).get("title", a["role_key"]),
        "status": a["status"],
        "vacancy_id": a["vacancy_id"],
        "started_at": iso(a["started_at"]),
        "seconds_left": max(0, SIM_LIMIT_SEC - (now() - a["started_at"])) if a["status"] == "open" else 0,
        "total": a["total"],
        "badge": a["badge"],
        "badge_pid": a["badge_pid"],
        "answer": a["answer"] or "",
        "questions": json.loads(a["questions_json"] or "[]"),
        "defense": json.loads(a["defense_json"] or "[]"),
        "scores": json.loads(a["scores_json"] or "null"),
        "finished_at": iso(a["finished_at"]),
        "inject_shown": bool(a["inject_at"]),
    }
    if include_case:
        out["case"] = json.loads(a["case_json"])
    return out


@app.post("/api/attempts")
def start_attempt(payload: AttemptStart, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "candidate")
    vacancy = None
    if payload.mode == "hiring":
        if not payload.code:
            raise HTTPException(400, "Введите код отбора, выданный компанией")
        vacancy = db.execute("SELECT * FROM vacancies WHERE code=?", (payload.code.strip().upper(),)).fetchone()
        if not vacancy:
            raise HTTPException(404, "Отбор с таким кодом не найден")
        if vacancy["status"] != "active":
            raise HTTPException(400, "Отбор уже закрыт")
        role_key = vacancy["role_key"]
        done = db.execute(
            "SELECT 1 FROM attempts WHERE user_id=? AND vacancy_id=? AND status='scored'",
            (u["id"], vacancy["id"]),
        ).fetchone()
        if done:
            raise HTTPException(409, "Вы уже прошли этот отбор — повторная попытка запрещена правилами вакансии")
    else:
        role_key = payload.role_key or "ai"
        if role_key not in engine.ROLES:
            raise HTTPException(400, "Неизвестная роль")

    db.execute("UPDATE attempts SET status='abandoned' WHERE user_id=? AND status IN ('open','submitted')", (u["id"],))
    seen = db.execute("SELECT COUNT(*) c FROM attempts WHERE user_id=? AND role_key=?", (u["id"], role_key)).fetchone()["c"]
    case = engine.build_case(role_key, seen, dict(vacancy) if vacancy else None)
    cur = db.execute(
        """INSERT INTO attempts (user_id, vacancy_id, mode, role_key, case_key, case_json, status,
           started_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
        (u["id"], vacancy["id"] if vacancy else None, payload.mode, role_key, case["key"],
         json.dumps(case, ensure_ascii=False), "open", now(), now()),
    )
    if vacancy:
        db.execute("UPDATE vacancies SET applicants=applicants+1 WHERE id=?", (vacancy["id"],))
    db.commit()
    a = db.execute("SELECT * FROM attempts WHERE id=?", (cur.lastrowid,)).fetchone()
    return {"attempt": attempt_public(a)}


@app.get("/api/attempts")
def my_attempts(user: sqlite3.Row | None = Depends(current_user)):
    u = require(user)
    rows = db.execute("SELECT * FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 40", (u["id"],)).fetchall()
    out = []
    for a in rows:
        v = db.execute("SELECT title, code FROM vacancies WHERE id=?", (a["vacancy_id"],)).fetchone() if a["vacancy_id"] else None
        item = attempt_public(a, include_case=False)
        item["case_title"] = (json.loads(a["case_json"]) or {}).get("title", "")
        item["vacancy_title"] = v["title"] if v else None
        out.append(item)
    return {"attempts": out}


@app.get("/api/attempts/{aid}")
def attempt_detail(aid: int, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user)
    a = db.execute("SELECT * FROM attempts WHERE id=?", (aid,)).fetchone()
    if not a:
        raise HTTPException(404, "Сессия не найдена")
    if a["user_id"] != u["id"]:
        owns = a["vacancy_id"] and db.execute(
            "SELECT 1 FROM vacancies WHERE id=? AND owner_id=?", (a["vacancy_id"], u["id"])
        ).fetchone()
        if not owns:
            raise HTTPException(403, "Нет доступа к этой сессии")
    return {"attempt": attempt_public(a)}


@app.post("/api/attempts/{aid}/inject")
def reveal_inject(aid: int, body: dict[str, Any] = Body(default={}), user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "candidate")
    a = db.execute("SELECT * FROM attempts WHERE id=? AND user_id=?", (aid, u["id"])).fetchone()
    if not a:
        raise HTTPException(404, "Сессия не найдена")
    case = json.loads(a["case_json"])
    if not case.get("inject_enabled", True):
        return {"inject": None}
    if not a["inject_at"]:
        db.execute(
            "UPDATE attempts SET inject_at=?, inject_offset=? WHERE id=?",
            (now(), int(body.get("offset") or 0), aid),
        )
        db.commit()
    return {"inject": case["inject"], "at": iso(now())}


@app.post("/api/attempts/{aid}/submit")
def submit_attempt(aid: int, payload: SubmitIn, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "candidate")
    a = db.execute("SELECT * FROM attempts WHERE id=? AND user_id=?", (aid, u["id"])).fetchone()
    if not a:
        raise HTTPException(404, "Сессия не найдена")
    if a["status"] == "scored":
        raise HTTPException(409, "Сессия уже оценена")
    if len(payload.answer.strip()) < MIN_ANSWER_CHARS:
        raise HTTPException(400, f"Минимальный объём решения — {MIN_ANSWER_CHARS} символов")
    qs = engine.pick_questions(payload.answer)
    db.execute(
        """UPDATE attempts SET answer=?, questions_json=?, telemetry_json=?, status='submitted',
           submitted_at=? WHERE id=?""",
        (payload.answer, json.dumps(qs, ensure_ascii=False), json.dumps(payload.telemetry), now(), aid),
    )
    db.commit()
    return {"questions": qs, "submitted_at": iso(now())}


@app.post("/api/attempts/{aid}/finish")
def finish_attempt(aid: int, payload: FinishIn, user: sqlite3.Row | None = Depends(current_user)):
    u = require(user, "candidate")
    a = db.execute("SELECT * FROM attempts WHERE id=? AND user_id=?", (aid, u["id"])).fetchone()
    if not a:
        raise HTTPException(404, "Сессия не найдена")
    if a["status"] == "scored":
        return {"attempt": attempt_public(a)}
    if a["status"] != "submitted":
        raise HTTPException(400, "Сначала сдайте решение")
    case = json.loads(a["case_json"])
    answer = a["answer"] or ""
    offset = int(a["inject_offset"] or 0)
    tail = answer[offset:] if offset and offset < len(answer) else (answer if not a["inject_at"] else answer[-400:])
    tele = {**json.loads(a["telemetry_json"] or "{}"), **(payload.telemetry or {})}
    result = engine.score_attempt(
        role_key=a["role_key"],
        case_key=a["case_key"],
        answer=answer,
        tail=tail,
        defense_answers=payload.defense,
        telemetry=tele,
        inject_enabled=bool(case.get("inject_enabled", True)),
    )
    pid = secrets.token_urlsafe(9) if result["badge"] != "none" else None
    db.execute(
        """UPDATE attempts SET defense_json=?, telemetry_json=?, scores_json=?, total=?, badge=?,
           badge_pid=?, status='scored', finished_at=? WHERE id=?""",
        (json.dumps(payload.defense, ensure_ascii=False), json.dumps(tele), json.dumps(result, ensure_ascii=False),
         result["total"], result["badge"], pid, now(), aid),
    )
    db.commit()
    a = db.execute("SELECT * FROM attempts WHERE id=?", (aid,)).fetchone()
    return {"attempt": attempt_public(a), "stats": user_stats(u)}


@app.get("/api/badge/{pid}")
def public_badge(pid: str):
    a = db.execute("SELECT * FROM attempts WHERE badge_pid=?", (pid,)).fetchone()
    if not a:
        raise HTTPException(404, "Бейдж не найден или отозван")
    u = get_user(a["user_id"])
    sc = json.loads(a["scores_json"] or "{}")
    case = json.loads(a["case_json"] or "{}")
    return {
        "badge": {
            "pid": pid,
            "name": u["name"] if u else "",
            "role_title": engine.ROLES.get(a["role_key"], {}).get("title", a["role_key"]),
            "case_title": case.get("title", ""),
            "total": a["total"],
            "badge": a["badge"],
            "badge_label": sc.get("badge_label", ""),
            "criteria": [{"title": c["title"], "score": c["score"], "max": c["max"]} for c in sc.get("criteria", [])],
            "rubric_version": sc.get("rubric_version", engine.RUBRIC_VERSION),
            "fingerprint": sc.get("fingerprint", ""),
            "issued_at": iso(a["finished_at"]),
            "flags": sc.get("flags", []),
        }
    }


# ─────────────────────────────────────────────────────────────────────────────
# Демо-данные
# ─────────────────────────────────────────────────────────────────────────────

DEMO_ANSWERS = [
    # сильное решение
    """Разбиваю задачу на четыре блока: поиск по документам, генерация ответа, контроль достоверности, эскалация.
1) Retrieval. Документы (12 000) режу на чанки по 700 символов с перекрытием, эмбеддинги храню в pgvector рядом с основной PostgreSQL — отдельный сервис не нужен, значит укладываемся в бюджет $300/мес. Гибридный поиск: BM25 + вектор, затем реранк топ-20 до топ-5.
2) Генерация. Дешёвая модель через API, промпт с жёстким требованием отвечать только по переданному контексту. Данные не покидают РК: тексты обращений анонимизирую, персональные поля вырезаю до отправки.
3) Контроль. Считаю уверенность как комбинацию: score лучшего документа ниже порога либо модель не нашла подтверждения в контексте — сразу эскалация на оператора. Порог калибрую на золотой выборке из 300 реальных обращений.
4) Стоимость. 4 000 обращений в сутки = 120 000 в месяц. Кэш частых вопросов (топ-200 закрывает около 40% трафика) снимает почти половину вызовов модели, поэтому остаётся примерно 70 000 платных обращений — это укладывается в лимит.
Наблюдаемость: логирую долю эскалаций, долю ответов без источника, латентность p95 и стоимость за обращение. Если доля ответов без источника растёт, значит поиск деградировал, и я это увижу раньше пользователя. Срок 3 недели: первая неделя — индекс и поиск, вторая — ответы и эскалация, третья — метрики и нагрузочный прогон на FastAPI.""",
    # среднее решение
    """Сделаю RAG: положу документы в вектор, по запросу достану релевантные и отдам модели. FastAPI как сервис, PostgreSQL для истории диалогов. Если модель не уверена, передаю оператору. Кэширую частые ответы, чтобы снизить стоимость.
По бюджету: беру недорогую модель через API, GPU не нужны. Данные храню в РК. Мониторинг через логи, буду смотреть ошибки и время ответа.
За три недели реально успеть базовую версию: сначала поиск, потом ответы, потом эскалация. Качество проверю на выборке вопросов, посчитаю долю правильных ответов вручную.""",
    # слабое решение
    """Сделаю чат-бота на LLM. Загружу в него документы и он будет отвечать клиентам. Если не знает ответ — напишет, что не знает, и позовёт человека. Использую Python и FastAPI. Постараюсь уложиться в бюджет, выберу недорогую модель. Проверю, что всё работает, на тестовых вопросах перед запуском.""",
]

DEMO_TAIL = [
    """ После смены вводных: бюджет $80 и p95 < 2 секунд. Отказываюсь от реранка на каждом запросе — он давал +400 мс и заметную часть стоимости; оставляю его только когда разрыв между первым и вторым документом меньше 15%. Кэш расширяю до семантического (нормализованный запрос + порог близости), ожидаю рост покрытия до 60%. Беру самую дешёвую модель с коротким контекстом: топ-3 документа вместо топ-5. Жертвую точностью на редких длинных вопросах — по ним чаще пойдёт эскалация на оператора, и я честно фиксирую это как рост нагрузки на поддержку примерно на 8%.""",
    """ Бюджет урезали — возьму модель подешевле и уменьшу количество документов в контексте, чтобы быстрее отвечать. Добавлю кэш. Возможно, качество немного упадёт, но по скорости уложимся.""",
    """ Буду оптимизировать, чтобы работало быстрее и дешевле.""",
]

DEMO_DEFENSE = [
    ["Порог уверенности считаю по score лучшего документа и по наличию цитаты в ответе: если цитаты нет — эскалация, потому что длина ответа ничего не говорит о его обоснованности.",
     "Кэш инвалидирую по версии документа: при обновлении базы поднимаю версию индекса, и все записи кэша со старой версией перестают отдаваться.",
     "Первой за рамки выйдет статья на вызовы модели при пиковых днях распродаж — урежу контекст до топ-3 и подниму порог эскалации."],
    ["Если уверенность низкая, отдаю оператору. Смотрю на score поиска.",
     "Кэш чищу раз в сутки.",
     "Дороже всего модель, буду брать дешевле."],
    ["Модель сама скажет, если не знает.", "", ""],
]

DEMO_CANDIDATES = [
    ("Айдана Сериккали", "aidana.s@demo.kz", "Алматы", 0, 0, {"paste": 0, "blur": 1, "idle": 1, "cpm": 310}),
    ("Данияр Оспанов", "daniyar.o@demo.kz", "Астана", 0, 0, {"paste": 0, "blur": 0, "idle": 2, "cpm": 265}),
    ("Мадина Жумабек", "madina.zh@demo.kz", "Алматы", 1, 0, {"paste": 0, "blur": 2, "idle": 1, "cpm": 240}),
    ("Тимур Ахметов", "timur.a@demo.kz", "Шымкент", 1, 1, {"paste": 1, "blur": 3, "idle": 2, "cpm": 420}),
    ("Ольга Ким", "olga.k@demo.kz", "Алматы", 1, 1, {"paste": 0, "blur": 1, "idle": 3, "cpm": 205}),
    ("Ержан Сапаров", "erzhan.s@demo.kz", "Караганда", 2, 1, {"paste": 0, "blur": 4, "idle": 5, "cpm": 180}),
    ("Камила Нурланова", "kamila.n@demo.kz", "Алматы", 2, 2, {"paste": 2, "blur": 2, "idle": 2, "cpm": 700}),
    ("Руслан Бек", "ruslan.b@demo.kz", "Астана", 0, 1, {"paste": 0, "blur": 2, "idle": 2, "cpm": 290}),
    ("Асель Тулеген", "asel.t@demo.kz", "Алматы", 1, 0, {"paste": 0, "blur": 0, "idle": 1, "cpm": 330}),
    ("Нурсултан Бай", "nur.b@demo.kz", "Тараз", 2, 2, {"paste": 1, "blur": 5, "idle": 4, "cpm": 150}),
]


def seed_demo() -> None:
    """Идемпотентно создаёт демо-аккаунты, вакансию и наполненный shortlist."""
    if db.execute("SELECT 1 FROM users WHERE email='hr@sagat.kz'").fetchone():
        return
    ts = now()
    db.execute(
        "INSERT INTO users (email,name,role,org,city,pass_hash,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?)",
        ("hr@sagat.kz", "Айгерим Касымова", "company", "TechnoDom Digital", "Алматы", hash_password("sagat2026"), 1, ts),
    )
    hr_id = db.execute("SELECT id FROM users WHERE email='hr@sagat.kz'").fetchone()["id"]
    db.execute(
        "INSERT INTO users (email,name,role,org,city,pass_hash,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?)",
        ("student@sagat.kz", "Алишер Бекенов", "candidate", "КазНУ · 3 курс", "Алматы", hash_password("sagat2026"), 1, ts),
    )
    cur = db.execute(
        """INSERT INTO vacancies (owner_id,title,role_key,city,stack,budget,days,threshold,applicants,
           inject_on,local_data,code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (hr_id, "Junior AI Engineer · продуктовая команда", "ai", "Алматы",
         "Python, FastAPI, PostgreSQL + pgvector", 300, 14, 65, 214, 1, 1, "SG-DEMO1", ts - 86400 * 9),
    )
    vid = cur.lastrowid
    case = engine.build_case("ai", 0, dict(db.execute("SELECT * FROM vacancies WHERE id=?", (vid,)).fetchone()))
    case_json = json.dumps(case, ensure_ascii=False)

    for i, (name, email, city, quality, tail_q, tele) in enumerate(DEMO_CANDIDATES):
        db.execute(
            "INSERT INTO users (email,name,role,org,city,pass_hash,is_demo,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (email, name, "candidate", "", city, hash_password(secrets.token_hex(8)), 1, ts - 86400 * 8),
        )
        uid = db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()["id"]
        body = DEMO_ANSWERS[quality]
        tail = DEMO_TAIL[tail_q]
        answer = body + "\n" + tail
        defense = DEMO_DEFENSE[min(2, max(quality, tail_q))]
        qs = engine.pick_questions(answer)
        res = engine.score_attempt(
            role_key="ai", case_key=case["key"], answer=answer, tail=tail,
            defense_answers=defense, telemetry=tele, inject_enabled=True,
        )
        started = ts - 86400 * (7 - i % 6) - 3600
        pid = secrets.token_urlsafe(9) if res["badge"] != "none" else None
        db.execute(
            """INSERT INTO attempts (user_id,vacancy_id,mode,role_key,case_key,case_json,status,started_at,
               inject_at,submitted_at,finished_at,answer,inject_offset,questions_json,defense_json,
               telemetry_json,scores_json,total,badge,badge_pid,hr_status,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uid, vid, "hiring", "ai", case["key"], case_json, "scored", started,
             started + 1800, started + 2700, started + 3000, answer, len(body) + 1,
             json.dumps(qs, ensure_ascii=False), json.dumps(defense, ensure_ascii=False),
             json.dumps(tele), json.dumps(res, ensure_ascii=False), res["total"], res["badge"], pid,
             "shortlist" if res["total"] >= 72 else "new", started),
        )

    # две career-попытки демо-студента: история, тренд и бейдж в кабинете кандидата
    st_id = db.execute("SELECT id FROM users WHERE email='student@sagat.kz'").fetchone()["id"]
    for j, (role_key, quality, tail_q, days_ago, tele) in enumerate(
        [("ai", 1, 1, 21, {"paste": 1, "blur": 2, "idle": 1, "cpm": 230}), ("ai", 0, 0, 5, {"paste": 0, "blur": 0, "idle": 1, "cpm": 275})]
    ):
        c = engine.build_case(role_key, j, None)
        body = DEMO_ANSWERS[quality]
        tail = DEMO_TAIL[tail_q]
        answer = body + "\n" + tail
        defense = DEMO_DEFENSE[min(2, max(quality, tail_q))]
        qs = engine.pick_questions(answer)
        res = engine.score_attempt(
            role_key=role_key, case_key=c["key"], answer=answer, tail=tail,
            defense_answers=defense, telemetry=tele, inject_enabled=True,
        )
        started = ts - 86400 * days_ago
        pid = secrets.token_urlsafe(9) if res["badge"] != "none" else None
        db.execute(
            """INSERT INTO attempts (user_id,vacancy_id,mode,role_key,case_key,case_json,status,started_at,
               inject_at,submitted_at,finished_at,answer,inject_offset,questions_json,defense_json,
               telemetry_json,scores_json,total,badge,badge_pid,hr_status,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (st_id, None, "career", role_key, c["key"], json.dumps(c, ensure_ascii=False), "scored", started,
             started + 1500, started + 2600, started + 2900, answer, len(body) + 1,
             json.dumps(qs, ensure_ascii=False), json.dumps(defense, ensure_ascii=False),
             json.dumps(tele), json.dumps(res, ensure_ascii=False), res["total"], res["badge"], pid,
             "new", started),
        )
    db.commit()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
