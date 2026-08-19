FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 python3 python3-pip python3-venv sox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/shiva
RUN python3 -m venv /opt/venv
COPY voice/asr/requirements.txt /tmp/asr-requirements.txt
RUN pip install --no-cache-dir -r /tmp/asr-requirements.txt
COPY voice ./voice

EXPOSE 8101
CMD ["python", "-m", "voice.asr.server"]
