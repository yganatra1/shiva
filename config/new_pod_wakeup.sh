curl http://127.0.0.1:11434/api/embed \
  -d '{
    "model": "embeddinggemma",
    "input": "Shiva memory test",
    "keep_alive": "24h"
  }'

pgrep -af "ollama serve" || nohup ollama serve > /workspace/shiva/logs/ollama.log 2>&1 &

curl -s http://127.0.0.1:11434/api/generate \
-H "Content-Type: application/json" \
-d '{
  "model": "gemma4:26b-a4b-it-q4_K_M",
  "prompt": "",
  "keep_alive": "24h"
}'

curl -s http://127.0.0.1:11434/api/generate \
-H "Content-Type: application/json" \
-d '{
  "model": "gemma4:26b-a4b-it-q4_K_M",
  "prompt": "Reply only with: Shiva ready",
  "stream": false,
  "keep_alive": "24h"
}' | jq