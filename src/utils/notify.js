const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";

const getDb = (db) => db || require("../db");

// --- recipient resolvers ----------------------------------------------
// All return arrays of user ids (strings), active users only.

function activeManagerIds(db) {
  return getDb(db).prepare("SELECT id FROM users WHERE role = ? AND status = 'Active'").all(MANAGER).map((r) => r.id);
}

// Active users with any of `roles` assigned to `customer` (via user_divisions).
function activeIdsForDivision(customer, roles, db) {
  if (!customer || !roles || roles.length === 0) return [];
  const placeholders = roles.map(() => "?").join(",");
  return getDb(db).prepare(`
    SELECT DISTINCT u.id FROM users u
    JOIN user_divisions ud ON ud.user_id = u.id
    WHERE u.status = 'Active' AND ud.customer = ? AND u.role IN (${placeholders})
  `).all(customer, ...roles).map((r) => r.id);
}

// Logistics Staff assigned to a given division.
function activeLogisticsIdsForDivision(customer, db) {
  return activeIdsForDivision(customer, [LOGISTICS], db);
}

// SPV / Manager Divisi assigned to a given division — "division watchers"
// who see milestone events for every DR in their division, not just their own.
function activeDivisionWatcherIds(customer, db) {
  return activeIdsForDivision(customer, ["SPV", "Manager Divisi"], db);
}

// The delivery's requester is stored as a display name, not an id. Name
// isn't unique in the schema, so this can return more than one id — notifying
// all of them is the safe choice for that rare case.
function userIdsByName(name, db) {
  if (!name) return [];
  return getDb(db).prepare("SELECT id FROM users WHERE name = ? AND status = 'Active'").all(name).map((r) => r.id);
}

// --- writing notifications -------------------------------------------
// One row per recipient. De-dupes the id list and drops the actor (no point
// telling someone about their own action). Never throws — a notification
// failure must not break the request that triggered it.
function notify(userIds, { type, title, body = "", refType = null, refId = null, actor = null }, db) {
  try {
    const d = getDb(db);
    const actorIds = new Set(actor ? userIdsByName(actor, d) : []);
    const recipients = [...new Set(userIds)].filter((id) => id && !actorIds.has(id));
    if (recipients.length === 0) return;
    const now = new Date().toISOString();
    const stmt = d.prepare(`
      INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id, actor, created_at)
      VALUES (@user_id, @type, @title, @body, @ref_type, @ref_id, @actor, @created_at)
    `);
    d.exec("BEGIN");
    try {
      for (const user_id of recipients) {
        stmt.run({ user_id, type, title, body, ref_type: refType, ref_id: refId, actor, created_at: now });
      }
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  } catch (err) {
    console.error(`[notify] failed for type "${type}":`, err.message);
  }
}

module.exports = { notify, activeManagerIds, activeIdsForDivision, activeLogisticsIdsForDivision, activeDivisionWatcherIds, userIdsByName };
