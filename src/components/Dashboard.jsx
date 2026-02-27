import { useState } from 'react';
import { useNodeData } from '../hooks/useNodeData';
import SummaryBar from './SummaryBar';
import NodeCard from './NodeCard';
import NodeDetail from './NodeDetail';

export default function Dashboard() {
  const { nodes, loading } = useNodeData();
  const [selectedNode, setSelectedNode] = useState(null);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400 text-lg animate-pulse">Loading nodes...</div>
      </div>
    );
  }

  const hpNodes = nodes.filter((n) => n.type === 'hp');
  const mnNodes = nodes.filter((n) => n.type === 'mn');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">D</span>
              </div>
              <h1 className="text-xl font-bold">Dash Testnet Dashboard</h1>
            </div>
            <span className="text-xs text-gray-500">
              {hpNodes.length} HP + {mnNodes.length} Regular Masternodes
            </span>
          </div>
          <SummaryBar nodes={nodes} />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-8">
        {/* HP Masternodes */}
        {hpNodes.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              HP Masternodes <span className="text-gray-600">({hpNodes.length})</span>
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {hpNodes.map((node) => (
                <NodeCard
                  key={node.name}
                  node={node}
                  onClick={setSelectedNode}
                />
              ))}
            </div>
          </section>
        )}

        {/* Regular Masternodes */}
        {mnNodes.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Masternodes <span className="text-gray-600">({mnNodes.length})</span>
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {mnNodes.map((node) => (
                <NodeCard
                  key={node.name}
                  node={node}
                  onClick={setSelectedNode}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Detail Modal */}
      <NodeDetail
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
      />
    </div>
  );
}
