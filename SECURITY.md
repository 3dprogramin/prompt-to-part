# Security

## Run Jig on your own computer only

Jig has no login. Anyone who can reach its port can use your API keys, read your designs and spend your credits. Docker Compose therefore publishes it on `127.0.0.1` only, and `pnpm start` listens there too. Keep it that way: don't expose Jig to the internet or put it behind a public proxy. To use it from a phone, only open it on a network you trust (`JIG_BIND` and `JIG_HOSTS` in `.env`).

## Run it in Docker

Use Docker Compose for everyday use (the README's quick start). Without Docker, Jig and the programs it starts (Claude Code, Bambu Studio, Blender) run as your user, with access to all your files and keys; in Docker, a problem that got past Jig's own walls stays inside a container with a read-only file system, no extra privileges and only Jig's data. See *Why Docker* in the README.

## What Jig protects against

Model scripts are written by Claude from your prompts, photos and web pages, so Jig treats them as untrusted code (see *Sandbox* in the README): they run in an SES compartment, in a separate Node process that can't read your files, start programs or reach the network. Attached meshes are imported and repaired in the same locked-down process, and OpenSCAD files run in a separate worker of their own. The API answers only Jig's own pages (host and origin checks, and an `X-Jig` header on writes), against DNS rebinding and cross-site requests.

## Reporting a vulnerability

If you find a way around any of this (a model script, web page, attachment or request that reaches your files, network, keys or another design), please don't open a public issue. Email **andrei@3dprogramin.io** with the steps to reproduce it and the Jig version (shown next to the logo). You'll get an answer within a few days, and credit in the fix if you want it.
