FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/shiva
RUN python3 -m venv /opt/venv
COPY voice/tts/requirements.txt /tmp/tts-requirements.txt
RUN pip install --no-cache-dir -r /tmp/tts-requirements.txt
COPY voice ./voice

EXPOSE 8102
CMD ["python", "-m", "voice.tts.server"]
