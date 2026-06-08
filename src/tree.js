// tree.js — local→Overleaf file/folder create/delete/rename via the project's
// authenticated REST endpoints (verified on www.overleaf.com):
//   POST   /project/{id}/doc        {name, parent_folder_id}      -> {_id}
//   POST   /project/{id}/folder     {name, parent_folder_id}      -> {_id}
//   POST   /project/{id}/{type}/{id}/rename   {name}              -> 204
//   DELETE /project/{id}/{type}/{id}                              -> 204
// All need the CSRF token from <meta name="ol-csrfToken">. type ∈ doc|file|folder.

/** Scrape the CSRF token the REST endpoints require. */
export async function getCsrf(page) {
  return page.evaluate(() => {
    const m = document.querySelector('meta[name="ol-csrfToken"]');
    return (m && m.content) || window.csrfToken || null;
  });
}

async function api(page, base, csrf, method, path, body) {
  return page.evaluate(
    async ({ base, csrf, method, path, body }) => {
      try {
        const r = await fetch(base + path, {
          method,
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-Csrf-Token": csrf },
          body: body ? JSON.stringify(body) : undefined,
        });
        let data = null;
        const t = await r.text();
        try { data = t ? JSON.parse(t) : null; } catch { data = t.slice(0, 200); }
        return { ok: r.ok, status: r.status, data };
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
    },
    { base, csrf, method, path, body }
  );
}

/**
 * Build a { "folder/sub" -> folderId } map from the raw joinProjectResponse
 * project, plus the root folder id under "". Lets us resolve a file's parent.
 */
export function folderIdMap(project) {
  const map = new Map();
  const root = project && project.rootFolder && project.rootFolder[0];
  if (!root) return { rootId: null, map };
  map.set("", root._id);
  const walk = (folder, prefix) => {
    for (const f of folder.folders || []) {
      const p = prefix ? `${prefix}/${f.name}` : f.name;
      map.set(p, f._id);
      walk(f, p);
    }
  };
  walk(root, "");
  return { rootId: root._id, map };
}

/**
 * Ensure every ancestor folder of `relPath` exists; return the parent folder id.
 *
 * Concurrency-safe: a bulk add (e.g. dropping a whole project into the mirror)
 * fires many watcher events at once, and several files can share a brand-new
 * folder. Without coordination they each POST `createFolder` for the same path —
 * the first wins, the rest get HTTP 400 (already exists). We dedupe concurrent
 * creates of the same path through an in-flight promise map on `folders`, and
 * treat "already exists" as success rather than a fatal error.
 */
export async function ensureParentFolder(page, base, pid, csrf, relPath, folders) {
  const parts = relPath.split("/").slice(0, -1); // drop the filename
  let parentId = folders.rootId;
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    parentId = await ensureOneFolder(page, base, pid, csrf, part, cur, parentId, folders);
  }
  return parentId;
}

/** Create (or resolve) a single folder `cur` (= `parentPath/name`) idempotently. */
function ensureOneFolder(page, base, pid, csrf, name, cur, parentId, folders) {
  if (folders.map.has(cur)) return Promise.resolve(folders.map.get(cur));
  if (!folders._inflight) folders._inflight = new Map();
  // Atomic check-and-set (no await between): the first caller installs the job,
  // every concurrent caller for the same path awaits that one job.
  const pending = folders._inflight.get(cur);
  if (pending) return pending;
  const job = (async () => {
    if (folders.map.has(cur)) return folders.map.get(cur); // filled by a sibling/CDP echo
    const r = await api(page, base, csrf, "POST", `/project/${pid}/folder`, { name, parent_folder_id: parentId });
    let id = r.ok && r.data && r.data._id;
    if (!id) {
      // Almost certainly "already exists" (concurrent or prior create). Resolve
      // its id from the map — a sibling create or the CDP treeNewFolder echo
      // populates it within a beat — instead of failing the file op.
      id = folders.map.get(cur) || (await waitForFolderId(folders, cur, 1500));
      if (!id) throw new Error(`createFolder ${cur}: HTTP ${r.status}`);
    }
    folders.map.set(cur, id);
    return id;
  })();
  folders._inflight.set(cur, job);
  job.finally(() => { if (folders._inflight.get(cur) === job) folders._inflight.delete(cur); }).catch(() => {});
  return job;
}

/** Poll `folders.map` for `cur` up to `ms` (the CDP echo fills it shortly after a create). */
function waitForFolderId(folders, cur, ms) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (folders.map.has(cur)) return resolve(folders.map.get(cur));
      if (Date.now() - start >= ms) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function createDoc(page, base, pid, csrf, name, parentFolderId) {
  const r = await api(page, base, csrf, "POST", `/project/${pid}/doc`, { name, parent_folder_id: parentFolderId });
  const id = r.data && (r.data._id || (r.data.doc && r.data.doc._id));
  if (!r.ok || !id) throw new Error(`createDoc ${name}: HTTP ${r.status}`);
  return id;
}

export async function deleteEntity(page, base, pid, csrf, type, id) {
  const r = await api(page, base, csrf, "DELETE", `/project/${pid}/${type}/${id}`);
  // 404 = already gone (e.g. a parent-folder delete cascaded first) — that's the
  // outcome we wanted, so treat it as success rather than a noisy error.
  if (!r.ok && r.status !== 204 && r.status !== 404) throw new Error(`delete ${type} ${id}: HTTP ${r.status}`);
}

export async function renameEntity(page, base, pid, csrf, type, id, name) {
  const r = await api(page, base, csrf, "POST", `/project/${pid}/${type}/${id}/rename`, { name });
  if (!r.ok && r.status !== 204) throw new Error(`rename ${type} ${id}: HTTP ${r.status}`);
}

/**
 * Upload (or replace) a binary file. Overleaf's uploader reads the filename from
 * a `name` form field (verified: omitting it -> 422 invalid_filename). Uploading
 * the same name into the same folder replaces the existing file (old entity is
 * removed, a new one created). `b64` is the file's base64 content.
 * Returns { id, hash }.
 */
export async function uploadFile(page, base, pid, csrf, name, parentFolderId, b64) {
  const r = await page.evaluate(
    async ({ base, pid, csrf, name, parentFolderId, b64 }) => {
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append("name", name);
        fd.append("qqfile", new Blob([bytes]), name);
        const url = `${base}/project/${pid}/upload?folder_id=${parentFolderId}&qqfilename=${encodeURIComponent(name)}`;
        const resp = await fetch(url, { method: "POST", credentials: "include", headers: { "X-Csrf-Token": csrf }, body: fd });
        let d = null; const t = await resp.text(); try { d = JSON.parse(t); } catch { /* */ }
        return { ok: resp.ok && d && d.success, status: resp.status, id: d && d.entity_id, hash: d && d.hash };
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
    },
    { base, pid, csrf, name, parentFolderId, b64 }
  );
  if (!r.ok || !r.id) throw new Error(`upload ${name}: HTTP ${r.status}${r.error ? " " + r.error : ""}`);
  return { id: r.id, hash: r.hash };
}

/** Download a binary file's bytes via /file/{id}. Returns base64, or null. */
export async function downloadFileB64(page, base, pid, fileId) {
  return page.evaluate(
    async ({ base, pid, fileId }) => {
      try {
        const r = await fetch(`${base}/project/${pid}/file/${fileId}`, { credentials: "include" });
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        return btoa(bin);
      } catch {
        return null;
      }
    },
    { base, pid, fileId }
  );
}
