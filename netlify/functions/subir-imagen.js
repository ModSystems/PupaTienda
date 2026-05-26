/**
 * Netlify Function: subir-imagen
 * Proxy seguro para subir imágenes a ImgBB.
 * La API key nunca llega al cliente — vive solo en Netlify.
 *
 * Variable de entorno necesaria en Netlify:
 *   IMGBB_API_KEY → tu key de imgbb.com/api
 */

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { imagen, nombre } = JSON.parse(event.body);

    if (!imagen) {
      return { statusCode: 400, body: JSON.stringify({ error: "No se recibió imagen" }) };
    }

    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "API key no configurada" }) };
    }

    // Armar FormData para ImgBB (espera base64 puro, sin el prefijo data:...)
    const base64 = imagen.includes(",") ? imagen.split(",")[1] : imagen;

    const form = new URLSearchParams();
    form.append("key",   apiKey);
    form.append("image", base64);
    if (nombre) form.append("name", nombre);

    const res  = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      body:   form,
    });

    const data = await res.json();

    if (data.success) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: data.data.url }),
      };
    } else {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: data.error?.message || "Error en ImgBB" }),
      };
    }

  } catch (err) {
    console.error("Error en subir-imagen:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error interno: " + err.message }),
    };
  }
};