# HLS Media Auditor v10 Defense

Ferramenta local para auditar seus próprios sites: encontra mídia, faz auditoria de cookies, procura vazamentos de URLs assinadas, testa candidatos full sem usar tokens vazados e gera página/relatório de defesa.

## Rodar

```bat
copy .env.example .env
set PUPPETEER_SKIP_DOWNLOAD=true
npm install --ignore-scripts --no-audit --no-fund
npm start
```

Abra `http://localhost:3000`.

## O que esta versão faz

- Mantém análise de mídia, preview seguro, Cookie Audit, Access Audit, HLS Resolver e Full URL Hunter.
- Adiciona Learning Engine em `data/learning-db.json`.
- Adiciona página separada `/defense` para resumir riscos e recomendações.
- Detecta URLs assinadas (`ttl`, `token`, `signature`, etc.), mas redige valores e não usa essas URLs para contornar 403.

## Saídas

Relatórios em `downloads/<slug>/reports/`.
