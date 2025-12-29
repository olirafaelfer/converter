# MediaDock — UX Mock (Dark Clean/Tech)

Este projeto é um **protótipo estático** (sem backend) para testar **UX/layout** em **GitHub Pages**.

## O que tem
- Tema escuro (clean/tech)
- Abas: Buscar / Colar link
- Resultados simulados (cards)
- Detecção de AdBlock (heurística) + botão para simular
- Modal de "anúncio recompensado" com contagem regressiva (mock) — **2 anúncios seguidos**
- "Download" simulado (baixa um arquivo placeholder)

## Como rodar localmente
Abra `index.html` no navegador.

> Dica: se quiser um servidor local simples:
- Python: `python -m http.server 8080`
- Node: `npx serve`

## Publicar no GitHub Pages
1. Crie um repositório e suba estes arquivos
2. Vá em **Settings → Pages**
3. Em **Build and deployment** escolha:
   - Source: Deploy from a branch
   - Branch: `main` e folder `/root`
4. Salve e aguarde gerar a URL

## Próximos passos (fase 2)
- Backend (API) para:
  - buscar/parsear links
  - conversão (FFmpeg/Workers)
  - integração com anúncios recompensados (proveedor) e validação
  - premium (pagamento + conta opcional)
