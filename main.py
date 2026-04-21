"""
FILM-SECURE · FastAPI Backend
==============================
Run locally:
  pip install fastapi uvicorn python-multipart jinja2 redis boto3
  uvicorn main:app --reload --port 8000
"""
import os
import uuid
import json

import redis as redis_lib
import boto3

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request

app = FastAPI(title="FILM-SECURE API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="template")

# ── Connect to Redis (job queue) ──────────────────────────────────────────────
# Redis runs on the same EC2 machine, so host is "localhost"
redis_client = redis_lib.Redis(
    host=os.getenv("REDIS_HOST", "localhost"),
    port=6379,
    decode_responses=True
)

# ── Connect to AWS S3 (file storage) ─────────────────────────────────────────
s3_client = boto3.client("s3", region_name=os.getenv("AWS_REGION", "ap-southeast-1"))
S3_BUCKET  = os.getenv("S3_BUCKET", "your-mlops-bucket")   # ← you will set this later


# ── Serve frontend ────────────────────────────────────────────────────────────
@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# ── Upload video ──────────────────────────────────────────────────────────────
@app.post("/api/upload")
async def upload_video(
    file: UploadFile = File(...),
    interp_factor: int = Form(2),
    quality: str = Form("high"),
):
    # 1. Create a unique ID for this job (like a ticket number)
    job_id = str(uuid.uuid4())

    # 2. Define where to store the file in S3
    #    e.g.  uploads/abc-123/myvideo.mp4
    s3_key = f"uploads/{job_id}/{file.filename}"

    # 3. Upload the video directly to S3
    s3_client.upload_fileobj(file.file, S3_BUCKET, s3_key)

    # 4. Build the job message that the worker will read
    job_message = {
        "job_id":        job_id,
        "s3_input_key":  s3_key,
        "interp_factor": interp_factor,
        "quality":       quality,
    }

    # 5. Push the job into the Redis queue so the worker picks it up
    redis_client.rpush("film_jobs", json.dumps(job_message))

    # 6. Save the initial status so the frontend can start polling
    redis_client.set(
        f"job:{job_id}",
        json.dumps({
            "job_id":   job_id,
            "status":   "queued",
            "progress": 0,
            "message":  "Job received. Waiting for worker.",
            "result":   None,
        }),
        ex=7200  # expires after 2 hours
    )

    return JSONResponse({"job_id": job_id})


# ── Poll job status ───────────────────────────────────────────────────────────
@app.get("/api/job/{job_id}")
async def get_job_status(job_id: str):
    # Read whatever the worker last wrote to Redis
    raw = redis_client.get(f"job:{job_id}")

    if not raw:
        return JSONResponse(
            {"job_id": job_id, "status": "not_found",
             "progress": 0, "message": "Job not found.", "result": None},
            status_code=404
        )

    return JSONResponse(json.loads(raw))


# ── Download result ───────────────────────────────────────────────────────────
@app.get("/api/download/{job_id}")
async def download_result(job_id: str):
    # Read job info from Redis to get the S3 output key
    raw = redis_client.get(f"job:{job_id}")
    if not raw:
        return JSONResponse({"detail": "Job not found"}, status_code=404)

    job_data = json.loads(raw)

    if job_data.get("status") != "completed":
        return JSONResponse({"detail": "Job not completed yet"}, status_code=400)

    # If we already have a pre-signed URL, return it directly
    if job_data.get("download_url"):
        return JSONResponse({"download_url": job_data["download_url"]})

    # Otherwise generate a fresh one from S3
    s3_output_key = job_data.get("s3_output_key")
    if not s3_output_key:
        return JSONResponse({"detail": "Output file not found"}, status_code=404)

    url = s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": s3_output_key},
        ExpiresIn=3600
    )
    return JSONResponse({"download_url": url})