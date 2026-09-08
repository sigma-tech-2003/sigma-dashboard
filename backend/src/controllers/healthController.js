export function healthCheck(_req, res) {
  res.status(200).json({ status: "ok" });
}
