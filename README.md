# SAMA Images Worker

Worker que recibe imágenes aprobadas desde el panel de Administración y las guarda en Cloudflare R2. La búsqueda se realiza manualmente en Google Imágenes; este Worker no depende de SerpApi.

## Configuración de R2

En `wrangler.toml` debe existir un binding llamado `IMAGES_BUCKET`:

```toml
[[r2_buckets]]
binding = "IMAGES_BUCKET"
bucket_name = "sama-images"
```

También se necesita una URL pública para servir los objetos guardados. Puede ser un dominio personalizado o la URL del propio Worker:

```powershell
npx wrangler secret put PUBLIC_BASE_URL
```

El valor debe terminar sin `/`, por ejemplo:

```text
https://sama-images-api.developpage.workers.dev
```

Configura los secretos de autenticación:

```powershell
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

Despliega el Worker:

```powershell
npx wrangler deploy
```

## Acciones

El endpoint autenticado acepta:

- `POST { "action": "save", "sku": "...", "images": [...] }`

Cada imagen puede incluir `imageUrl` para que el Worker la descargue, o `imageData` como `data:image/...;base64,...` para archivos arrastrados desde el equipo. El Worker devuelve `saved[].imageUrl`; la primera imagen se registra en `products."Image(url)"`.

El endpoint `GET /products/<sku>/<filename>` sirve los objetos desde R2 cuando el binding está configurado.
