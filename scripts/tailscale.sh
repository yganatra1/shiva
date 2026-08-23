curl -fsSL https://tailscale.com/install.sh | sh

nohup tailscaled \
  --tun=userspace-networking \
  --state=/workspace/shiva/data/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  > /workspace/shiva/logs/tailscaled.log 2>&1 &

tailscale serve --bg 3000