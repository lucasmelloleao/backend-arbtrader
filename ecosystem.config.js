module.exports = {
  apps: [
    {
      name: "api-server",
      script: "dist/index.js",
      max_memory_restart: "300M",
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: "scanner",
      script: "dist/strategy/perpetuals/loop-scanner-robot.js",
      node_args: "--expose-gc --max-old-space-size=1200",
      max_memory_restart: "1400M",
      restart_delay: 5000,
      max_restarts: 15,
      kill_timeout: 8000,
    },
    {
      name: "funding-arb",
      script: "dist/strategy/perpetuals/funding-arb.js",
      node_args: "--expose-gc --max-old-space-size=850",
      max_memory_restart: "1000M",
      restart_delay: 15000,
      listen_timeout: 15000,
      max_restarts: 10,
      kill_timeout: 8000,
    },
    /* Desativado temporariamente em favor do forex-scalper
    {
      name: "forex-arb",
      script: "dist/strategy/forex/forex-arb.js",
      node_args: "--expose-gc --max-old-space-size=300",
      max_memory_restart: "400M",
      restart_delay: 10000,
      kill_timeout: 8000,
    },
    {
      name: "forex-scanner",
      script: "dist/strategy/forex/loop-scanner-robot.js",
      node_args: "--expose-gc --max-old-space-size=300",
      autorestart: true,
      max_restarts: 15,
      max_memory_restart: "400M",
      restart_delay: 10000,
      kill_timeout: 8000,
    },
    */
    {
      name: "prediction-arb",
      script: "dist/strategy/prediction-arb/prediction-arb.js",
      node_args: "--expose-gc --max-old-space-size=400",
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "500M",
      restart_delay: 10000,
      kill_timeout: 8000,
    },
    {
      name: "forex-scalper",
      script: "dist/strategy/forex/forex-scalper.js",
      node_args: "--expose-gc --max-old-space-size=300",
      autorestart: true,
      max_restarts: 15,
      max_memory_restart: "400M",
      restart_delay: 5000,
      kill_timeout: 8000,
    }
  ]
};


