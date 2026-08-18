const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username.toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  if (user.status !== "Active") return res.status(403).json({ error: "This account has been deactivated" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid username or password" });

  const payload = { id: user.id, name: user.name, username: user.username, role: user.role, assignment: user.assignment, customer: user.customer || null };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: payload });
});

module.exports = router;
