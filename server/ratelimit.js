/** A small in-memory limiter: at most `max` hits per key (usually an IP address) in any `windowMs`. */
export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> timestamps of recent hits

  const prune = (list, now) => {
    while (list.length && now - list[0] >= windowMs) list.shift();
    return list;
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, list] of hits) if (!prune(list, now).length) hits.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    /** Records a hit and returns true if it's allowed. */
    hit(key, now = Date.now()) {
      const list = prune(hits.get(key) ?? [], now);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
  };
}

/** Express middleware that answers 429 once a client goes over the limit. */
export function limitRequests(limiter) {
  return (req, res, next) => {
    if (limiter.hit(req.ip)) return next();
    res.status(429).json({ error: 'Too many requests, slow down a little' });
  };
}
