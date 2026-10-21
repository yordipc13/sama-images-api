const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

function validRemoteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function extensionFor(contentType) {
  return {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  }[contentType] || "bin";
}

async function requireAdmin(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "Faltan SUPABASE_URL o SUPABASE_ANON_KEY en el Worker." }, 500);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Sesión administrativa requerida." }, 401);
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: authorization,
    },
  });
  const user = await response.json().catch(() => ({}));
  if (!response.ok || user.app_metadata?.role !== "admin") return json({ error: "Se requiere una cuenta administradora." }, 403);
  return null;
}

async function searchImages(body, env) {
  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_ENGINE_ID) {
    return json({ error: "Faltan GOOGLE_SEARCH_API_KEY o GOOGLE_SEARCH_ENGINE_ID en el Worker." }, 500);
  }
  const query = String(body.query || "").trim();
  if (!query) return json({ error: "El campo query es obligatorio." }, 400);

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", env.GOOGLE_SEARCH_API_KEY);
  url.searchParams.set("cx", env.GOOGLE_SEARCH_ENGINE_ID);
  url.searchParams.set("q", query);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", "10");
  url.searchParams.set("safe", "active");
  url.searchParams.set("imgType", "photo");

  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: payload.error?.message || "Google rechazó la búsqueda." }, response.status >= 500 ? 502 : response.status);

  const items = (payload.items || []).map(item => ({
    imageUrl: item.link,
    thumbnailUrl: item.image?.thumbnailLink || item.link,
    title: item.title || "",
    sourcePageUrl: item.image?.contextLink || item.displayLink || "",
    width: item.image?.width || null,
    height: item.image?.height || null,
  })).filter(item => validRemoteUrl(item.imageUrl));

  return json({ items });
}

async function saveImages(body, env) {
  if (!env.IMAGES_BUCKET || !env.PUBLIC_BASE_URL) {
    return json({ error: "Faltan el binding IMAGES_BUCKET o PUBLIC_BASE_URL en el Worker." }, 500);
  }
  const sku = String(body.sku || "").trim();
  const images = Array.isArray(body.images) ? body.images : [];
  if (!sku || !images.length || images.length > 8) {
    return json({ error: "Se requiere SKU y entre 1 y 8 imágenes." }, 400);
  }

  const saved = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!validRemoteUrl(image?.imageUrl)) continue;
    const response = await fetch(image.imageUrl, { redirect: "follow" });
    if (!response.ok) continue;
    const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!allowedImageTypes.has(contentType) || contentLength > MAX_IMAGE_BYTES) continue;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;

    const extension = extensionFor(contentType);
    const key = `products/${encodeURIComponent(sku)}/${index === 0 ? "primary" : `secondary-${String(index).padStart(2, "0")}`}.${extension}`;
    await env.IMAGES_BUCKET.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: {
        sku,
        sourceUrl: String(image.imageUrl),
        sourcePageUrl: String(image.sourcePageUrl || ""),
      },
    });
    saved.push({
      imageUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`,
      sourceUrl: String(image.imageUrl),
      sourcePageUrl: String(image.sourcePageUrl || ""),
      sortOrder: index,
      isPrimary: index === 0,
    });
  }

  if (!saved.length) return json({ error: "Ninguna imagen pudo descargarse y validarse." }, 422);
  return json({ saved });
}

async function downloadImage(body) {
  if (!validRemoteUrl(body.imageUrl)) return json({ error: "URL de imagen no válida." }, 400);
  const response = await fetch(body.imageUrl, { redirect: "follow" });
  if (!response.ok) return json({ error: "No se pudo descargar la imagen." }, 422);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!allowedImageTypes.has(contentType)) return json({ error: "La URL no devolvió una imagen compatible." }, 422);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) return json({ error: "La imagen supera el tamaño permitido." }, 422);
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return json({ error: "La imagen descargada no es válida." }, 422);
  return new Response(bytes, {
    headers: {
      ...corsHeaders,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${String(body.filename || "imagen").replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "GET" && env.IMAGES_BUCKET) {
      const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
      if (!key) return json({ error: "Archivo no especificado." }, 404);
      const object = await env.IMAGES_BUCKET.get(key);
      if (!object) return json({ error: "Imagen no encontrada." }, 404);
      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("ETag", object.httpEtag);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(object.body, { headers });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return json({ error: "Método no permitido." }, 405);
    const authorizationError = await requireAdmin(request, env);
    if (authorizationError) return authorizationError;
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "El cuerpo debe ser JSON válido." }, 400);
    }
    try {
      if (body.action === "search") return await searchImages(body, env);
      if (body.action === "save") return await saveImages(body, env);
      if (body.action === "download") return await downloadImage(body);
      return json({ error: "Acción no válida. Usa search o save." }, 400);
    } catch (error) {
      return json({ error: error.message || "Error interno del Worker." }, 500);
    }
  },
};
