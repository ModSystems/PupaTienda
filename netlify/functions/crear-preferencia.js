/**
 * Netlify Function: crear-preferencia
 * Crea una preferencia de pago en MercadoPago.
 * Valida los precios contra Firestore (REST) para que el cliente
 * no pueda manipular montos.
 *
 * Variables de entorno necesarias en Netlify:
 *   MP_ACCESS_TOKEN  → tu Access Token de MercadoPago (Producción o Sandbox)
 *   FIREBASE_API_KEY → tu apiKey de Firebase (la misma del index.html)
 *   FIREBASE_PROJECT → tu projectId de Firebase (pupatienda-c9e56)
 *   URL              → se setea automáticamente en Netlify (para el webhook)
 */

exports.handler = async (event) => {
  // Solo POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { items, comprador, baseUrl } = JSON.parse(event.body);

    // ── 1. Validar que los datos mínimos existan ───────────────
    if (!items || items.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Carrito vacío" }) };
    }
    if (!comprador?.nombre || !comprador?.telefono) {
      return { statusCode: 400, body: JSON.stringify({ error: "Datos del comprador incompletos" }) };
    }

    // ── 2. Validar precios y stock contra Firestore REST ───────
    const API_KEY = process.env.FIREBASE_API_KEY;
    const PROJECT = process.env.FIREBASE_PROJECT;
    const firestoreBase = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/productos`;

    const itemsValidados = [];

    for (const item of items) {
      if (!item.productoId || !item.cantidad || item.cantidad <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: `Item inválido: ${item.productoId}` }) };
      }

      // Leer el producto desde Firestore
      const res = await fetch(`${firestoreBase}/${item.productoId}?key=${API_KEY}`);
      if (!res.ok) {
        return { statusCode: 400, body: JSON.stringify({ error: `Producto no encontrado: ${item.productoId}` }) };
      }
      const doc = await res.json();
      const fields = doc.fields || {};

      const nombre  = fields.nombre?.stringValue  || "Producto";
      const precio  = parseFloat(fields.precio?.doubleValue || fields.precio?.integerValue || 0);
      const stock   = parseInt(fields.stock?.integerValue   || 0);
      const activo  = fields.activo?.booleanValue !== false;

      // Validaciones de seguridad
      if (!activo)                   return { statusCode: 400, body: JSON.stringify({ error: `Producto pausado: ${nombre}` }) };
      if (precio <= 0)               return { statusCode: 400, body: JSON.stringify({ error: `Precio inválido: ${nombre}` }) };
      if (item.cantidad > stock)     return { statusCode: 400, body: JSON.stringify({ error: `Stock insuficiente: ${nombre}` }) };

      itemsValidados.push({
        id:         item.productoId,
        title:      nombre,
        quantity:   item.cantidad,
        unit_price: precio,     // precio real desde Firestore, no del cliente
        currency_id: "ARS",
      });
    }

    // ── 3. Crear preferencia en MercadoPago ────────────────────
    const successUrl = `${baseUrl}?mp_status=approved`;
    const failureUrl = `${baseUrl}?mp_status=failure`;
    const pendingUrl = `${baseUrl}?mp_status=pending`;
    const webhookUrl = `${process.env.URL}/.netlify/functions/mp-webhook`;

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: itemsValidados,
        payer: {
          name:  comprador.nombre,
          phone: { number: comprador.telefono },
        },
        back_urls: {
          success: successUrl,
          failure: failureUrl,
          pending: pendingUrl,
        },
        auto_return: "approved",
        notification_url: webhookUrl,
        // Guardamos los items para que el webhook pueda descontar el stock
        external_reference: JSON.stringify({
          items: items.map(i => ({ id: i.productoId, cantidad: i.cantidad })),
          comprador,
        }),
        statement_descriptor: "PUPA TIENDA",
      }),
    });

    if (!mpRes.ok) {
      const err = await mpRes.text();
      console.error("MP error:", err);
      return { statusCode: 502, body: JSON.stringify({ error: "Error al crear preferencia en MercadoPago" }) };
    }

    const preferencia = await mpRes.json();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id:          preferencia.id,
        init_point:  preferencia.init_point,       // Producción
        sandbox_url: preferencia.sandbox_init_point, // Testing
      }),
    };

  } catch (err) {
    console.error("Error en crear-preferencia:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error interno del servidor" }),
    };
  }
};