# Social Canary

Astro + TypeScript site generated from Brotea's `astro` stack. Content-first
and SEO-friendly; interactive features render as React islands.

```bash
npm install
npm run dev      # local dev server
npm run build    # production build (CI runs this)
```

## Features

```bash
brotea add <feature> --app .
```

A feature's React component is dropped under `src/features/<name>/` and mounted
as an island on its own page under `src/pages/`. See `brotea.json` for what is
installed here.
