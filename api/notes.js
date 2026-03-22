const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("node:crypto");

const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
const SUPABASE_TABLE = process.env.SUPABASE_NOTES_TABLE || "notes";
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || "notes-files";

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return null;
  }

  if (!globalThis.__supabaseClient) {
    globalThis.__supabaseClient = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }

  return globalThis.__supabaseClient;
}

function setCommonHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function getQuery(req) {
  const fromUrl = {};
  const parsedUrl = new URL(req.url || "/api/notes", "http://localhost");
  parsedUrl.searchParams.forEach((value, key) => {
    fromUrl[key] = value;
  });

  if (!req.query || typeof req.query !== "object") {
    return fromUrl;
  }

  return { ...fromUrl, ...req.query };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeFileName(fileName) {
  return normalizeText(fileName).replace(/[^a-zA-Z0-9._ -]/g, "_");
}

function normalizeBase64(data) {
  if (typeof data !== "string") return "";
  const trimmed = data.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("data:") && trimmed.includes(",")) {
    return trimmed.slice(trimmed.indexOf(",") + 1).replace(/\s/g, "");
  }

  return trimmed.replace(/\s/g, "");
}

function readRawBody(req) {
  if (req.readableEnded) {
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.length ? JSON.parse(req.body.toString("utf8")) : {};
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) return {};

  return JSON.parse(rawBody);
}

function toPublicNote(note) {
  return {
    id: note.id,
    title: note.title,
    course: note.course,
    section: note.section,
    file: note.file_name || note.fileName || note.file || null
  };
}

async function listNotes(query, res) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return sendJson(res, 500, {
      error: "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    });
  }

  const search = normalizeText(query.search).toLowerCase();
  const section = normalizeText(query.section);
  const course = normalizeText(query.course);

  let dbQuery = supabase
    .from(SUPABASE_TABLE)
    .select("id,title,course,section,file_name")
    .order("id", { ascending: true });

  if (search) {
    dbQuery = dbQuery.ilike("title", `%${search}%`);
  }

  if (section) {
    dbQuery = dbQuery.eq("section", section);
  }

  if (course) {
    dbQuery = dbQuery.eq("course", course);
  }

  const { data, error } = await dbQuery;
  if (error) {
    console.error("Supabase list error:", error.message);
    return sendJson(res, 500, { error: "Could not load notes" });
  }

  return sendJson(res, 200, (data || []).map(toPublicNote));
}

async function readStorageFileAsBuffer(fileData) {
  if (!fileData) return null;
  if (Buffer.isBuffer(fileData)) return fileData;
  if (typeof fileData.arrayBuffer === "function") {
    const arrayBuffer = await fileData.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  return null;
}

async function downloadNote(query, res) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return sendJson(res, 500, {
      error: "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    });
  }

  const id = Number(query.download);
  if (!Number.isInteger(id)) {
    return sendJson(res, 400, { error: "Invalid download id" });
  }

  const { data: note, error: noteError } = await supabase
    .from(SUPABASE_TABLE)
    .select("id,file_name,file_path,file_type")
    .eq("id", id)
    .maybeSingle();

  if (noteError) {
    console.error("Supabase fetch note error:", noteError.message);
    return sendJson(res, 500, { error: "Could not fetch file metadata" });
  }

  if (!note || !note.file_path) {
    return sendJson(res, 404, { error: "File not found" });
  }

  const { data: fileData, error: fileError } = await supabase.storage.from(SUPABASE_BUCKET).download(note.file_path);
  if (fileError) {
    console.error("Supabase download error:", fileError.message);
    return sendJson(res, 404, { error: "File not found" });
  }

  const fileBuffer = await readStorageFileAsBuffer(fileData);
  if (!fileBuffer) {
    return sendJson(res, 500, { error: "Could not process file from storage" });
  }

  const fileName = sanitizeFileName(note.file_name) || "note-file";
  res.statusCode = 200;
  res.setHeader("Content-Type", note.file_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Length", String(fileBuffer.length));
  return res.end(fileBuffer);
}

function validateBase64Content(base64String) {
  if (!base64String) return false;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64String)) return false;

  try {
    const decoded = Buffer.from(base64String, "base64");
    return decoded.length > 0;
  } catch {
    return false;
  }
}

async function createNote(body, res) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return sendJson(res, 500, {
      error: "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    });
  }

  const title = normalizeText(body.title);
  const course = normalizeText(body.course);
  const section = normalizeText(body.section);
  const fileName = normalizeText(body.fileName);
  const fileType = normalizeText(body.fileType) || "application/octet-stream";
  const fileData = normalizeBase64(body.fileData);

  if (!title || !course || !section || !fileName || !fileData) {
    return sendJson(res, 400, { error: "title, course, section, fileName and fileData are required" });
  }

  if (!validateBase64Content(fileData)) {
    return sendJson(res, 400, { error: "fileData must be valid base64 content" });
  }

  const decodedFile = Buffer.from(fileData, "base64");
  if (decodedFile.length > MAX_FILE_SIZE_BYTES) {
    return sendJson(res, 413, { error: "File too large. Max size is 4 MB." });
  }

  const safeFileName = sanitizeFileName(fileName) || "upload.bin";
  const filePath = `${Date.now()}-${randomUUID()}-${safeFileName}`;

  const { error: uploadError } = await supabase.storage.from(SUPABASE_BUCKET).upload(filePath, decodedFile, {
    contentType: fileType,
    upsert: false
  });

  if (uploadError) {
    console.error("Supabase upload error:", uploadError.message);
    return sendJson(res, 500, { error: "Could not upload file to Supabase Storage" });
  }

  const { data, error: insertError } = await supabase
    .from(SUPABASE_TABLE)
    .insert({
      title,
      course,
      section,
      file_name: safeFileName,
      file_path: filePath,
      file_type: fileType
    })
    .select("id,title,course,section,file_name")
    .single();

  if (insertError) {
    console.error("Supabase insert error:", insertError.message);
    await supabase.storage.from(SUPABASE_BUCKET).remove([filePath]);
    return sendJson(res, 500, { error: "Could not save note metadata" });
  }

  return sendJson(res, 201, toPublicNote(data));
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === "GET") {
    const query = getQuery(req);
    if (query.download) {
      return downloadNote(query, res);
    }
    return listNotes(query, res);
  }

  if (req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      return createNote(body, res);
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }
  }

  res.setHeader("Allow", "GET,POST,OPTIONS");
  return sendJson(res, 405, { error: "Method Not Allowed" });
};
