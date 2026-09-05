PLATAFORMA PARA DESENVOLVEDORES · OPEN BETA
O universo 3D que você
faz deploy, não constrói.
Registre uma coordenada permanente no espaço 3D.
Coloque o que quiser lá — objeto 3D, app web, Three.js ao vivo.
Qualquer pessoa no mundo navega até você pelo universo.
Infraestrutura,
não plataforma.
A App Store não cria os apps. A AWS não cria os produtos. O Roblox não cria os mundos.
O COSM fornece o universo. Você fornece o conteúdo.
Como o HTTP é o protocolo da web, o COSM:// é o protocolo do espaço 3D.
Cada coordenada é um endereço permanente — sem servidor, sem domínio, sem intermediário.
Você não hospeda um site. Você ocupa um ponto no universo.
Três formas de colocar
conteúdo na sua coordenada.
TYPE 01 — OBJETO 3D
.glb / .gltf
Aparece solto no universo — sem moldura, sem iframe. Animações automáticas. Exporte do Blender, Unity ou Spline.
PATCH /api/url3d
"url": "cdn.ex.com/obj.glb"
TYPE 02 — THREE.JS
Código ao vivo
Acesso a THREE, scene, camera e coordBase. Retorne um Object3D e ele aparece no universo.
return new THREE.Mesh(geo, mat)
TYPE 03 — WEB / IFRAME
Qualquer URL HTTPS
React, Vue, Unity WebGL, Shopify — tela cheia na coordenada. Scroll, clique e teclado funcionam dentro do espaço.
PATCH /api/url
"url": "meuapp.vercel.app"
O COSM não hospeda seus arquivos — só endereça. Modelos 3D e apps precisam estar publicados em algum lugar com URL pública antes de apontar pra sua coordenada.

Objeto 3D →Sketchfab, GitHub (raw), CDN próprio
Site / app →Vercel, Netlify, servidor próprio
A coordenada é
sua barra de endereço.
Quem registra uma coordenada tem controle absoluto — câmera, navegação, física, renderização. Tudo pode ser sobrescrito. É como digitar uma URL e chegar num universo 3D que você mesmo criou.

// Roda a cada frame enquanto o visitante estiver na sua coordenada
window._cosmLoop = (dt) => { meuObjeto.rotation.y += dt * 0.5meuObjeto.position.y = Math.sin(Date.now() / 600) * 20}
// Assume controle da câmera — desativa mouse/teclado padrão do COSM
window._cosmControls = false
camera.position.set(0, 80, 200)
camera.lookAt(0, 0, 0)
_cosmLoop(dt) — chamado todo frame na sua área. _cosmControls = false — câmera livre.
Ambos são removidos automaticamente ao sair da coordenada.
REST. Sem SDK.
Sem chave na beta.
POST /api/registrar
Registra coordenada → { coord_x, coord_y, coord_z }
body: { carteira, tipo, plano, nome }
POST /api/totp/iniciar
Gera a chave de segurança e o QR code — body: { carteira }. Obrigatório logo após registrar.
POST /api/totp/confirmar
Confirma o primeiro código e ativa a coordenada — body: { carteira, codigo } → devolve sessão
POST /api/totp/login
Login com TOTP já configurado — body: { carteira, codigo } → devolve sessão
PATCH /api/url3d
Define objeto 3D (.glb / .gltf público) — body: { carteira, url }
exige header Authorization: Bearer <sessão TOTP>
PATCH /api/url
Define conteúdo web — body: { carteira, url } — qualquer HTTPS
exige header Authorization: Bearer <sessão TOTP>
GET /api/coordenadas
Lista coordenadas com objetos 3D ativos → [ { coord_x, coord_y, coord_z, url_3d, nome } ]
GET /api/minha-coord/:x/:y/:z
Verifica existência e dono → { existe: bool }
