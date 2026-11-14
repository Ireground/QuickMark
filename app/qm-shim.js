// Quick Mark for Windows: gives the page the same storage API it uses on claude.ai,
// but every board, folder and image is saved as a file on this computer.
(function () {
  const N = window.qmNative;
  if (!N) return;

  const listeners = new Set(); // {kind:'coll'|'doc', coll, id, next}

  function snapColl(coll, rows, order) {
    let docs = rows.slice();
    if (order) {
      const [field, dir] = order;
      docs.sort((a, b) => {
        const x = a.data[field] || 0, y = b.data[field] || 0;
        return dir === 'desc' ? (y > x ? 1 : y < x ? -1 : 0) : (x > y ? 1 : x < y ? -1 : 0);
      });
    }
    return {
      docs: docs.map(r => ({ id: r.id, data: () => JSON.parse(JSON.stringify(r.data)) })),
      metadata: { fromCache: false, hasPendingWrites: false }
    };
  }

  async function fire(coll, id) {
    for (const l of Array.from(listeners)) {
      if (l.coll !== coll) continue;
      try {
        if (l.kind === 'coll') l.next(snapColl(coll, await N.list(coll), l.order));
        else if (l.id === id) {
          const d = await N.get(coll, id);
          l.next({ exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), metadata: { hasPendingWrites: false } });
        }
      } catch (e) { if (l.err) l.err(e); }
    }
  }

  function collection(coll) {
    const q = {
      _order: null,
      orderBy(field, dir) { const c = collection(coll); c._order = [field, dir || 'asc']; return c; },
      onSnapshot(next, err) {
        const l = { kind: 'coll', coll, next, err, order: this._order };
        listeners.add(l);
        N.list(coll).then(rows => { if (listeners.has(l)) next(snapColl(coll, rows, l.order)); }).catch(e => err && err(e));
        return () => listeners.delete(l);
      }
    };
    return q;
  }

  function doc(path) {
    const [coll, id] = path.split('/');
    return {
      async set(data) { await N.set(coll, id, JSON.parse(JSON.stringify(data))); fire(coll, id); },
      async update(patch) { await N.update(coll, id, JSON.parse(JSON.stringify(patch))); fire(coll, id); },
      async delete() { await N.del(coll, id); fire(coll, id); },
      onSnapshot(next, err) {
        const l = { kind: 'doc', coll, id, next, err };
        listeners.add(l);
        N.get(coll, id).then(d => {
          if (listeners.has(l)) next({ exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined), metadata: { hasPendingWrites: false } });
        }).catch(e => err && err(e));
        return () => listeners.delete(l);
      }
    };
  }

  const db = { collection, doc };

  const assets = {
    async upload(blob) {
      const buf = await blob.arrayBuffer();
      const id = await N.upload(buf, blob.type || 'image/png');
      return { id };
    }
  };

  const downloads = {
    async save({ filename, data }) {
      let buf;
      if (data instanceof Blob) buf = await data.arrayBuffer();
      else if (typeof data === 'string') buf = new TextEncoder().encode(data).buffer;
      else buf = data;
      const r = await N.saveFile(filename, buf);
      if (r === 'declined') { const e = new Error('declined'); e.code = 'declined'; throw e; }
      return { status: 'saved' };
    }
  };

  window.claude = {
    use(name) {
      if (name === 'db') return Promise.resolve(db);
      if (name === 'assets') return Promise.resolve(assets);
      if (name === 'downloads') return Promise.resolve(downloads);
      return Promise.reject(new Error('not available'));
    }
  };
})();
