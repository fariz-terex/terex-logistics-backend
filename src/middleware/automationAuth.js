// Separate authentication path for external automation (n8n) — a static
// API key in a header, checked against an env var the user sets themselves
// in Railway. Deliberately NOT merged into requireAuth/requireRole: this
// keeps normal user JWT auth completely untouched, and if AUTOMATION_API_KEY
// is ever unset, every request here is rejected by default (secure by
// default — no accidental open door before the key is actually configured).
function requireAutomationKey(req, res, next) {
  const configuredKey = process.env.AUTOMATION_API_KEY;
  const suppliedKey = req.header("X-Automation-Key");
  if (!configuredKey) {
    return res.status(503).json({ error: "Automation API is not configured on this server (AUTOMATION_API_KEY not set)" });
  }
  if (!suppliedKey || suppliedKey !== configuredKey) {
    return res.status(401).json({ error: "Invalid or missing X-Automation-Key header" });
  }
  // A synthetic identity so shared business logic that reads req.user (or
  // just req.user.name for attribution) works unchanged for automated
  // calls — unscoped like Manager, since the automation may act across
  // any division depending on which Sheet triggered it.
  req.user = { id: "AUTOMATION", name: "n8n Automation (Google Sheet Sync)", role: "Admin / Manager Logistics", customers: [] };
  next();
}

module.exports = { requireAutomationKey };
