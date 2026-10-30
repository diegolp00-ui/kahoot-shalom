# 🚀 Desafío Shalom 2026 - Trivia Interactiva PICP (Kahoot Clon)

Plataforma interactiva multijugador en tiempo real diseñada para el **Programa de Inducción Cultural y de Puesto (PICP) 2026 - SHALOM**.

Permite evaluar a los nuevos colaboradores en vivo proyectando las preguntas en el proyector de la sala mientras los colaboradores responden desde sus smartphones con código PIN o código QR.

---

## 📦 Contenido de la Inducción (35 Preguntas Oficiales)
1. **Módulo 1: Identidad y Cultura** (Visión, Misión, red de agencias, flota de 380 camiones y +4,500 colaboradores).
2. **Módulo 2: RRHH y Asistencia** (4 marcaciones obligatorias, huellero/app, bono de asistencia, pagos BCP/BBVA, horas extras y descansos médicos CITT).
3. **Módulo 3: EPP y Normas de Seguridad** (Polo, pantalón reflectivo, botas, casco, guantes, política cero celulares, tomatodos transparentes y alcoholímetro).
4. **Módulo 4: Operaciones Huachipa** (Flujo Desembarcar → Clasificar → Pistolear → Embarcar, Huachipa 1 manual vs Huachipa 2 automatizado con Sorter, Crossbelt para talla S, Narrow para talla M+, mercancía especial directa al camión).
5. **Módulo 5: Stickers y Trazabilidad** (Orientación QR hacia arriba/lados, destinos LA/LB/LC a Lima, E a Provincia, Cooler para paquetería pequeña).
6. **Módulo 6: Estiba, Ergonomía y SST** (Límites de peso 25 kg varones / 15 kg mujeres, estiba pesada en base, postura ergonómica, pictogramas, sanciones y periodo de prueba).

---

## ⚡ Características de la Plataforma
* **100% Serverless / Sin Caídas:** Preparado para desplegar en **Vercel** como aplicación estática global ultra-rápida.
* **Tiempo Real con Supabase Broadcast:** Conexiones WebSocket globales de baja latencia sin necesidad de mantener un servidor Node.js encendido en una PC local.
* **Modo Autónomo / Fallback Local:** Funciona también sin internet o en red local mediante `BroadcastChannel`.
* **Auto-Avance Integrado:** Pregunta activa (20s) → Resultados y Cápsula Educativa de Refuerzo (6s) → Ranking parcial (4s) → Siguiente pregunta o Podio Final de forma 100% automática.
* **Exportación Excel / CSV para RRHH:** Descarga un reporte con Nombre, DNI/Sede, Puntaje, % de Aciertos y Condición (APROBADO ≥ 70% / POR REFORZAR).
* **Efectos de Sonido Web Audio API:** Reloj tic-tac, fanfarrias de acierto/error y podio final sin depender de archivos de audio externos.

---

## 🌐 Cómo Desplegar en Vercel (Paso a Paso)

### 1. Conectar tu repositorio en Vercel
1. Ingresa a [vercel.com](https://vercel.com) e inicia sesión con tu cuenta de GitHub.
2. Haz clic en **Add New...** → **Project**.
3. Selecciona el repositorio `kahoot-shalom`.
4. En **Framework Preset**, déjalo en *Other* (el archivo `vercel.json` ya configura la carpeta `public` automáticamente).
5. Presiona **Deploy**. En menos de 30 segundos tu aplicación estará activa con URL pública HTTPS (ejemplo: `https://kahoot-shalom.vercel.app`).

### 2. Conectar Supabase Realtime (Gratis, 1 minuto)
Para que los celulares de los colaboradores se conecten desde cualquier red (4G/5G/WiFi):
1. Crea un proyecto gratuito en [supabase.com](https://supabase.com).
2. Ve a **Project Settings** → **API**.
3. Copia el **Project URL** y el **anon public key**.
4. Puedes agregarlos de dos formas:
   * **En la web:** Abre la pantalla de anfitrión (`/host.html`), haz clic en **⚙️ Configurar Nube** y pega los dos valores.
   * **En el código:** Edita `public/supabase-config.js` y coloca los valores en `window.__SHALOM_SB_URL` y `window.__SHALOM_SB_KEY`.

---

## 💻 Ejecución Local
Simplemente abre `public/host.html` en tu navegador, o si prefieres el servidor Node local:
```bash
npm install
npm start
```
Abre en tu navegador:
* **Panel Anfitrión (Pantalla grande):** `http://localhost:3000/host.html`
* **Mando de Colaborador (Celular):** `http://localhost:3000/play.html`
