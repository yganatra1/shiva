FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 libgomp1 zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/shiva
RUN python3 -m venv /opt/venv
COPY face/requirements.txt /tmp/face-requirements.txt
# InsightFace declares the GUI OpenCV distribution. Restore the headless
# package last so its shared modules cannot be overwritten by that dependency.
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir -r /tmp/face-requirements.txt \
    && pip uninstall -y opencv-python \
    && pip install --no-cache-dir --force-reinstall --no-deps "opencv-python-headless>=4.11,<5"
COPY face ./face

EXPOSE 8103
CMD ["python", "-m", "face.server"]
