// Legacy network fixture; not a production default.
export const legacyNetwork = {
      name: 'devnet-moutai', displayName: 'Moutai', tag: 'devnet-moutai', chainType: 'devnet', coreNetwork: 'devnet-moutai', p2pPort: 20001,
      public: true, deployable: true, showBalances: true,
      endpoints: [
        { label: 'Insight', url: 'https://insight.moutai.networks.dash.org/insight/' },
        { label: 'Faucet', url: 'https://faucet.moutai.networks.dash.org/' },
        { label: 'Quorums', url: 'https://quorums.moutai.networks.dash.org/health' },
        { label: 'DAPI seed-1', url: 'https://seed-1.moutai.networks.dash.org:1443/', kind: 'dapi' },
      ],
      observationWindow: '4m', operationTimeout: '110m',
    };
