import { useState, useEffect, useCallback, useRef } from 'react';

export function useNodeData() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const eventSourceRef = useRef(null);

  // Initial fetch
  useEffect(() => {
    fetch('/api/nodes')
      .then((res) => res.json())
      .then((data) => {
        setNodes(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch nodes:', err);
        setLoading(false);
      });
  }, []);

  // SSE for real-time updates
  useEffect(() => {
    const es = new EventSource('/api/events');
    eventSourceRef.current = es;

    es.addEventListener('nodeUpdate', (event) => {
      const updated = JSON.parse(event.data);
      setNodes((prev) => {
        const idx = prev.findIndex((n) => n.name === updated.name);
        if (idx === -1) return [...prev, updated];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
    });

    es.onerror = () => {
      // EventSource auto-reconnects
      console.warn('SSE connection lost, reconnecting...');
    };

    return () => {
      es.close();
    };
  }, []);

  const refresh = useCallback(() => {
    fetch('/api/nodes')
      .then((res) => res.json())
      .then(setNodes)
      .catch(console.error);
  }, []);

  return { nodes, loading, refresh };
}
