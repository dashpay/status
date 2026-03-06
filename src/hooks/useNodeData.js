import { useState, useEffect, useCallback, useRef } from 'react';

export function useNodeData() {
  const [nodes, setNodes] = useState([]);
  const [proposer, setProposer] = useState({
    currentProposerNode: null,
    nextProposerNode: null,
    platformHeight: null,
  });
  const [loading, setLoading] = useState(true);
  const eventSourceRef = useRef(null);

  // Initial fetch
  useEffect(() => {
    Promise.all([
      fetch('/api/nodes').then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }),
      fetch('/api/proposer').then((res) => res.json()).catch(() => ({})),
    ])
      .then(([nodeData, proposerData]) => {
        setNodes(nodeData);
        if (proposerData) setProposer(proposerData);
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
      try {
        const updated = JSON.parse(event.data);
        setNodes((prev) => {
          const idx = prev.findIndex((n) => n.name === updated.name);
          if (idx === -1) return [...prev, updated];
          const next = [...prev];
          next[idx] = updated;
          return next;
        });
      } catch (err) {
        console.warn('Failed to parse SSE message:', err);
      }
    });

    es.addEventListener('proposerUpdate', (event) => {
      try {
        const data = JSON.parse(event.data);
        setProposer(data);
      } catch (err) {
        console.warn('Failed to parse proposer SSE:', err);
      }
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
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setNodes)
      .catch(console.error);
  }, []);

  // Annotate nodes with proposer role
  const annotatedNodes = nodes.map((node) => ({
    ...node,
    proposerRole:
      node.name === proposer.currentProposerNode ? 'current'
        : node.name === proposer.nextProposerNode ? 'next'
          : null,
  }));

  return { nodes: annotatedNodes, proposer, loading, refresh };
}
