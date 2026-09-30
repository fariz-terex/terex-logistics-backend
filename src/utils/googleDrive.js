// Minimal Google Drive client for archiving ORIGINAL photos (the app itself
// shows the compressed copies from the Railway bucket). Plain fetch, no
// googleapis dependency — only OAuth token exchange/refresh, folder
// find-or-create and a resumable upload are needed.
//
// Scope is drive.file: the app can only see files/folders it created itself
// in the connected account (logistik.terex@gmail.com), never the rest of
// that Drive — and that scope needs no Google app verification.
//
// Config (Railway env on the backend): GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, optional GOOGLE_REDIRECT_URI. The refresh token is
// obtained through the in-app "Hubungkan Google Drive" button and kept in
// app_settings — nobody copies tokens around by hand.
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const EXPECTED_ACCOUNT = "logistik.terex@gmail.com";

function oauthConfig(env = process.env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: env.GOOGLE_REDIRECT_URI || "https://backend-production-5543.up.railway.app/api/gdrive/callback",
  };
}
const isConfigured = (env = process.env) => { const c = oauthConfig(env); return !!(c.clientId && c.clientSecret); };

function authUrl(state, env = process.env) {
  const c = oauthConfig(env);
  const params = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state, login_hint: EXPECTED_ACCOUNT,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token error: ${data.error_description || data.error || res.status}`);
  return data;
}

async function exchangeCode(code, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const c = oauthConfig(env);
  return tokenRequest({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code" }, fetchImpl);
}

// Drive folder names can contain quotes; escape them for the q= query.
const qEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function createDriveClient({ refreshToken, env = process.env, fetchImpl = globalThis.fetch, folderCache }) {
  const c = oauthConfig(env);
  let accessToken = null;
  let expiresAt = 0;

  async function token() {
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    const data = await tokenRequest({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }, fetchImpl);
    accessToken = data.access_token;
    expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return accessToken;
  }

  async function api(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Drive ${method} ${res.status}: ${data.error?.message || ""}`.trim());
    return data;
  }

  async function about() {
    const data = await api("GET", `${API}/about?fields=user(emailAddress)`);
    return data.user?.emailAddress || null;
  }

  // "LMS Terex/Reconciliation/RC-1" -> folder id, creating what's missing.
  // folderCache ({ get(path), set(path, id) }) keeps ids across restarts.
  async function ensureFolder(path) {
    const parts = path.split("/").filter(Boolean);
    let parent = "root";
    let soFar = "";
    for (const name of parts) {
      soFar = soFar ? `${soFar}/${name}` : name;
      let id = folderCache?.get(soFar);
      if (!id) {
        const q = `name = '${qEscape(name)}' and mimeType = '${FOLDER_MIME}' and '${parent}' in parents and trashed = false`;
        const found = await api("GET", `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
        id = found.files?.[0]?.id || (await api("POST", `${API}/files?fields=id`, { name, mimeType: FOLDER_MIME, parents: [parent] })).id;
        folderCache?.set(soFar, id);
      }
      parent = id;
    }
    return parent;
  }

  // Resumable upload (originals are often > 5 MB, the multipart limit).
  async function uploadFile({ name, parentId, mimeType, body }) {
    const init = await fetchImpl(`${UPLOAD_API}/files?uploadType=resumable&fields=id,webViewLink`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(body.length) },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    if (!init.ok) throw new Error(`Google Drive upload init ${init.status}: ${(await init.text().catch(() => "")).slice(0, 200)}`);
    const location = init.headers.get("location");
    if (!location) throw new Error("Google Drive upload: tidak ada URL upload");
    const put = await fetchImpl(location, { method: "PUT", headers: { "Content-Type": mimeType, "Content-Length": String(body.length) }, body });
    const data = await put.json().catch(() => ({}));
    if (!put.ok) throw new Error(`Google Drive upload ${put.status}: ${data.error?.message || ""}`.trim());
    return { id: data.id, webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
  }

  return { about, ensureFolder, uploadFile };
}

module.exports = { oauthConfig, isConfigured, authUrl, exchangeCode, createDriveClient, SCOPE, EXPECTED_ACCOUNT };
