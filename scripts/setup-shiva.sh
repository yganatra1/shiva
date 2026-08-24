cd /workspace/shiva/repo

python3 -m venv /workspace/shiva/venvs/face
source /workspace/shiva/venvs/face/bin/activate

python -m pip install --upgrade pip setuptools wheel
python -m pip uninstall -y onnxruntime-gpu onnxruntime opencv-python
python -m pip install -r face/requirements.txt
python -m pip install --force-reinstall --no-deps "opencv-python-headless>=4.11,<5"
