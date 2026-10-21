# SAMA Images Worker

Worker para buscar candidatos con Google Programmable Search y descargar imágenes aprobadas para la galería local. El almacenamiento en R2 queda para una fase posterior.

## Configuración

1. Configura los secretos:

```powershell
npx wrangler secret put GOOGLE_SEARCH_API_KEY
npx wrangler secret put GOOGLE_SEARCH_ENGINE_ID
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

2. Revisa `wrangler.toml` y despliega:

```powershell
npx wrangler deploy
```

El endpoint acepta:

- `POST { "action": "search", "query": "..." }`
- `POST { "action": "download", "imageUrl": "...", "filename": "..." }`

Las imágenes solo se descargan después de la selección manual en Administración. Google y los sitios de origen pueden tener restricciones de uso; la aprobación del usuario debe considerar la licencia de cada imagen. En una fase posterior se puede agregar un destino R2 conservando los mismos nombres por SKU.
