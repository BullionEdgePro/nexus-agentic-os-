/**
 * Whether a message this business sent actually reached the person it was for.
 *
 * Its own file rather than a corner of `retrieval.ts`, where it briefly lived:
 * that module is about reading the knowledge base, this is about WhatsApp
 * delivery, and a constant filed under the wrong subject is found by whoever is
 * not looking for it.
 */

/**
 * The order a WhatsApp message moves through, and the only definition of it.
 *
 * Meta reports delivery asynchronously and DOES NOT PROMISE ORDER: `delivered`
 * and `read` arrive on separate webhook deliveries, either of which can be
 * retried, so a late `sent` overtaking an early `read` is ordinary rather than
 * exceptional. Applied blindly, that walks a message backwards and an operator
 * watching for stuck messages finds one that the customer has already read.
 *
 * Exported rather than written into the SQL because `recordDeliveryStatus`
 * passes this array to Postgres as a parameter and compares `array_position`
 * against it. There is therefore one ladder, not a TypeScript one and a SQL one
 * that agree until somebody edits either.
 *
 * `failed` is deliberately absent. It is not a rung — it is terminal, it can
 * arrive from any point, and nothing may move a message off it.
 */
export const DELIVERY_STATUS_LADDER = ["queued", "sent", "delivered", "read"] as const;
