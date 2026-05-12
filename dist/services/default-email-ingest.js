function pickField(obj, ...keys) {
    if (!obj || typeof obj !== 'object')
        return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null)
            return v;
    }
    return undefined;
}
function normaliseMessage(raw, id) {
    const graphId = pickField(raw, 'id', 'message_id', 'messageId') ?? '';
    const subject = pickField(raw, 'subject') ?? null;
    const fromObj = pickField(raw, 'from', 'sender') ?? null;
    let fromAddress = null;
    if (typeof fromObj === 'string')
        fromAddress = fromObj;
    else if (fromObj && typeof fromObj === 'object') {
        const ea = pickField(fromObj, 'emailAddress', 'email_address');
        fromAddress =
            ea?.address ??
                pickField(fromObj, 'address', 'email') ??
                null;
    }
    const receivedRaw = pickField(raw, 'received_at', 'receivedDateTime', 'received');
    const receivedAt = receivedRaw instanceof Date
        ? receivedRaw.toISOString()
        : typeof receivedRaw === 'string'
            ? receivedRaw
            : null;
    const atts = pickField(raw, 'attachments', 'has_attachments');
    const attachments = Array.isArray(atts)
        ? atts.map((a) => {
            const id = pickField(a, 'id', 'attachment_id', 'attachmentId') ?? '';
            const filename = pickField(a, 'name', 'filename', 'file_name') ?? '';
            const size = pickField(a, 'size', 'size_bytes') ?? 0;
            const ct = pickField(a, 'contentType', 'content_type') ?? null;
            return {
                attachment_id: id,
                filename,
                size_bytes: size,
                content_type: ct,
            };
        })
        : [];
    return {
        id,
        graphMessageId: graphId,
        raw,
        subject,
        fromAddress,
        receivedAt,
        attachments,
    };
}
export function createDefaultEmailIngestAdapter(options) {
    const log = options.logger ?? console;
    const cap = options.cacheSize ?? 1_000;
    const cache = new Map();
    const byGraphId = new Map();
    let nextId = 1;
    /** mailboxId → detach function returned by registerHandler */
    const handlers = new Map();
    /** detach functions for ownership/activity subscriptions */
    const eventDetachers = [];
    function evictIfFull() {
        while (cache.size > cap) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined)
                break;
            const m = cache.get(oldest);
            cache.delete(oldest);
            if (m)
                byGraphId.delete(m.graphMessageId);
        }
    }
    function ingest(raw) {
        const graphId = pickField(raw, 'id', 'message_id', 'messageId') ?? '';
        if (graphId && byGraphId.has(graphId)) {
            const id = byGraphId.get(graphId);
            return cache.get(id);
        }
        const id = nextId++;
        const msg = normaliseMessage(raw, id);
        cache.set(id, msg);
        if (msg.graphMessageId)
            byGraphId.set(msg.graphMessageId, id);
        evictIfFull();
        return msg;
    }
    // Bootstrap: SAM Admin sets `email_mailboxes.owner_app_id` to grant
    // a mailbox to a plugin. listMyMailboxes() returns those rows. We
    // register a handler per mailbox — no claimMailbox; that's an
    // operator action, not a plugin action.
    function attachHandler(mailboxId) {
        if (handlers.has(mailboxId))
            return; // already attached
        const detach = options.emailIngest.registerHandler(mailboxId, (...args) => {
            ingest(args[0]);
            return undefined;
        });
        handlers.set(mailboxId, detach);
    }
    function detachHandler(mailboxId) {
        const d = handlers.get(mailboxId);
        if (d) {
            try {
                d();
            }
            catch {
                // ignore
            }
            handlers.delete(mailboxId);
        }
    }
    function applyMailboxList(rows) {
        for (const r of rows) {
            const id = typeof r.id === 'string' ? r.id : null;
            if (!id)
                continue;
            attachHandler(id);
        }
        log.info?.(`[bank-reconcile email-ingest] attached to ${handlers.size} mailbox(es)`);
    }
    if (options.initialMailboxes) {
        // Test path: skip listMyMailboxes()
        applyMailboxList(options.initialMailboxes);
    }
    else {
        // Production path: ask SAM what's already assigned to us.
        Promise.resolve(options.emailIngest.listMyMailboxes())
            .then((rows) => {
            applyMailboxList(rows.map((r) => ({
                id: typeof r.id === 'string' ? r.id : undefined,
                email_address: typeof r.email_address === 'string' ? r.email_address : null,
            })));
        })
            .catch((err) => {
            log.warn?.(`[bank-reconcile email-ingest] listMyMailboxes failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    // Subscribe to ownership changes — operator-driven (SAM Admin UI).
    // When a mailbox is granted to us, attach a handler. When taken
    // away, detach.
    try {
        const detachOwnership = options.emailIngest.onOwnershipChange(async (event) => {
            const e = event;
            if (!e?.mailboxId)
                return;
            if (e.newOwnerAppId === options.appId &&
                e.previousOwnerAppId !== options.appId) {
                attachHandler(e.mailboxId);
            }
            else if (e.previousOwnerAppId === options.appId &&
                e.newOwnerAppId !== options.appId) {
                detachHandler(e.mailboxId);
            }
        });
        eventDetachers.push(detachOwnership);
    }
    catch {
        // onOwnershipChange optional in some SAM versions
    }
    const mailbox = {
        async sync() {
            // The SAM email-ingest service syncs continuously in the
            // background; nothing to do here. Provided as a no-op so callers
            // that rely on `sync` don't fail.
        },
        async list({ fromDate, pageSize }) {
            const since = fromDate.getTime();
            const items = [];
            for (const m of cache.values()) {
                if (m.receivedAt) {
                    const t = Date.parse(m.receivedAt);
                    if (Number.isFinite(t) && t < since)
                        continue;
                }
                items.push({
                    id: m.id,
                    subject: m.subject,
                    from_address: m.fromAddress,
                    received_at: m.receivedAt,
                    has_attachments: m.attachments.length > 0,
                    attachments: m.attachments,
                });
            }
            // Newest first.
            items.sort((a, b) => {
                const ax = a.received_at ? Date.parse(String(a.received_at)) : 0;
                const bx = b.received_at ? Date.parse(String(b.received_at)) : 0;
                return bx - ax;
            });
            return { emails: items.slice(0, pageSize) };
        },
        async getById(emailId) {
            const m = cache.get(emailId);
            if (!m)
                return null;
            return {
                id: m.id,
                subject: m.subject,
                from_address: m.fromAddress,
                received_at: m.receivedAt,
                has_attachments: m.attachments.length > 0,
                attachments: m.attachments,
            };
        },
    };
    const attachments = {
        async fetchAttachment({ emailId, attachmentId }) {
            const m = cache.get(emailId);
            if (!m)
                return null;
            try {
                const result = await options.emailIngest.fetchAttachment(m.raw, attachmentId);
                return {
                    bytes: new Uint8Array(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength),
                    filename: result.name,
                    contentType: result.contentType,
                };
            }
            catch (err) {
                log.error?.(`[email-ingest] fetchAttachment failed for email ${emailId}: ${err instanceof Error ? err.message : String(err)}`);
                return null;
            }
        },
    };
    async function shutdown() {
        for (const d of eventDetachers.splice(0)) {
            try {
                d();
            }
            catch {
                // ignore
            }
        }
        for (const [, d] of handlers) {
            try {
                d();
            }
            catch {
                // ignore
            }
        }
        handlers.clear();
        cache.clear();
        byGraphId.clear();
    }
    return { mailbox, attachments, shutdown };
}
//# sourceMappingURL=default-email-ingest.js.map