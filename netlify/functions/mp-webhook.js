/**
 * Netlify Function: mp-webhook
 * Recibe notificaciones de MercadoPago.
 * Cuando el pago es aprobado:
 *   1. Verifica el pago contra la API de MP
 *   2. Descuenta el stock en Firestore (transacción atómica)
 *   3. Guarda el pedido en la colección "pedidos"
 *
 * Variables de entorno adicionales necesarias:
 *   FIREBASE_SERVICE_ACCOUNT → JSON de cuenta de servicio de Firebase
 *                               (base64 o JSON string)
 *                               Firebase Console → Configuración → Cuentas de servicio
 *                               → Generar nueva clave privada
 */

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue }      = require("firebase-admin/firestore");

// Inicializar Firebase Admin una sola vez
function getDb() {
  if (getApps().length === 0) {
    let serviceAccount;
    try {
      // Intentar primero como JSON puro, luego como base64
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
      serviceAccount = JSON.parse(
        raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")
      );
    } catch (e) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT inválido: " + e.message);
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

exports.handler = async (event) => {
  // MP envía GET para validar la URL al configurarla
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "ok" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    // MP puede enviar el tipo como query param o en el body
    const topic = event.queryStringParameters?.topic || body.type;
    const id    = event.queryStringParameters?.id     || body.data?.id;

    // Solo procesamos notificaciones de pagos
    if (topic !== "payment" && topic !== "merchant_order") {
      return { statusCode: 200, body: "ignored" };
    }
    if (!id) {
      return { statusCode: 200, body: "no id" };
    }

    // ── 1. Verificar el pago con la API de MP ──────────────────
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
      headers: { "Authorization": `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      console.error("No se pudo obtener el pago:", id);
      return { statusCode: 200, body: "error fetching payment" };
    }

    const pago = await mpRes.json();

    // Solo procesar pagos aprobados
    if (pago.status !== "approved") {
      console.log(`Pago ${id} no aprobado: ${pago.status}`);
      return { statusCode: 200, body: "not approved" };
    }

    // ── 2. Verificar que no procesamos este pago ya ────────────
    const db = getDb();
    const pagoRef = db.collection("pagos_procesados").doc(String(id));
    const yaExiste = await pagoRef.get();
    if (yaExiste.exists) {
      console.log(`Pago ${id} ya fue procesado`);
      return { statusCode: 200, body: "already processed" };
    }

    // ── 3. Parsear external_reference ─────────────────────────
    let items = [], comprador = {};
    try {
      const ref = JSON.parse(pago.external_reference || "{}");
      items     = ref.items     || [];
      comprador = ref.comprador || {};
    } catch {
      console.error("No se pudo parsear external_reference");
      return { statusCode: 200, body: "bad reference" };
    }

    // ── 4. Transacción: descontar stock ────────────────────────
    await db.runTransaction(async (tx) => {
      const refs = items.map(i => db.collection("productos").doc(i.id));
      const docs = await Promise.all(refs.map(r => tx.get(r)));

      // Verificar stock disponible antes de descontar
      for (let i = 0; i < items.length; i++) {
        const doc = docs[i];
        if (!doc.exists) throw new Error(`Producto no encontrado: ${items[i].id}`);
        const stockActual = doc.data().stock || 0;
        if (stockActual < items[i].cantidad) {
          throw new Error(`Stock insuficiente para ${doc.data().nombre}`);
        }
      }

      // Descontar stock
      for (let i = 0; i < items.length; i++) {
        tx.update(refs[i], {
          stock: FieldValue.increment(-items[i].cantidad),
          actualizadoEn: FieldValue.serverTimestamp(),
        });
      }

      // Guardar el pedido
      const pedidoRef = db.collection("pedidos").doc();
      tx.set(pedidoRef, {
        pagoId:     String(pago.id),
        estado:     "pagado",
        metodo:     pago.payment_type_id || "online",
        total:      pago.transaction_amount,
        comprador,
        items,
        creadoEn:   FieldValue.serverTimestamp(),
      });

      // Marcar pago como procesado (evita duplicados)
      tx.set(pagoRef, {
        pagoId:   String(id),
        procesadoEn: FieldValue.serverTimestamp(),
      });
    });

    console.log(`✅ Pago ${id} procesado correctamente`);
    return { statusCode: 200, body: "ok" };

  } catch (err) {
    console.error("Error en mp-webhook:", err.message);
    // Devolvemos 200 para que MP no reintente (el error puede ser lógico)
    return { statusCode: 200, body: "error: " + err.message };
  }
};