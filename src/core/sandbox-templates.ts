export const DEFAULT_ALGOD_PORT = 4001;
export const INDEXER_IMAGE = "algorand/indexer:latest";
export const ALGORAND_IMAGE = "algorand/algod:latest";
export const CONDUIT_IMAGE = "algorandfoundation/conduit-localnet:latest";

export function getConfigJson(): string {
  return (
    '{ "GossipFanout": 1, "EndpointAddress": "0.0.0.0:8080", "DNSBootstrapID": "",' +
    ' "IncomingConnectionsLimit": 0, "Archival":true, "isIndexerActive":false, "EnableDeveloperAPI":true,' +
    ' "EnablePrivateNetworkAccessHeader":true}'
  );
}

export function getAlgodNetworkTemplate(): string {
  return `{
    "Genesis": {
      "NetworkName": "followermodenet",
      "RewardsPoolBalance": 0,
      "FirstPartKeyRound": 0,
      "LastPartKeyRound": NUM_ROUNDS,
      "Wallets": [
        {
          "Name": "Wallet1",
          "Stake": 40,
          "Online": true
        },
        {
          "Name": "Wallet2",
          "Stake": 40,
          "Online": true
        },
        {
          "Name": "Wallet3",
          "Stake": 20,
          "Online": true
        }
      ],
      "DevMode": true
    },
    "Nodes": [
      {
        "Name": "data",
        "IsRelay": true,
        "Wallets": [
          {
            "Name": "Wallet1",
            "ParticipationOnly": false
          },
          {
            "Name": "Wallet2",
            "ParticipationOnly": false
          },
          {
            "Name": "Wallet3",
            "ParticipationOnly": false
          }
        ]
      },
      {
        "Name": "follower",
        "IsRelay": false,
        "ConfigJSONOverride":
        "{\\"EnableFollowMode\\":true,\\"EndpointAddress\\":\\"0.0.0.0:8081\\",\\"MaxAcctLookback\\":64,\\"CatchupParallelBlocks\\":64,\\"CatchupBlockValidateMode\\":3}"
      }
    ]
  }
`;
}

export function getConduitYaml(): string {
  return `# Log verbosity: PANIC, FATAL, ERROR, WARN, INFO, DEBUG, TRACE
log-level: INFO

# If no log file is provided logs are written to stdout.
#log-file:

# Number of retries to perform after a pipeline plugin error.
retry-count: 10

# Time duration to wait between retry attempts.
retry-delay: "5s"

# Optional filepath to use for pidfile.
#pid-filepath: /path/to/pidfile

# Whether or not to print the conduit banner on startup.
hide-banner: false

# When enabled prometheus metrics are available on '/metrics'
metrics:
  mode: OFF
  addr: ":9999"
  prefix: "conduit"

# The importer is typically an algod follower node.
importer:
  name: localnet_algod
  config:
    lead-node-url: "http://algod:8080"
    follower-node-url: "http://algod:8081"
    token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# Zero or more processors may be defined to manipulate what data
# reaches the exporter.
processors:

# An exporter is defined to do something with the data.
exporter:
  name: postgresql
  config:
    # Pgsql connection string
    # See https://github.com/jackc/pgconn for more details
    connection-string: "host=indexer-db port=5432 user=algorand password=algorand dbname=indexerdb"

    # Maximum connection number for connection pool
    # This means the total number of active queries that can be running
    # concurrently can never be more than this
    max-conn: 20
`;
}

export function getDockerComposeYml(
  name = "algokit_sandbox",
  algodPort = DEFAULT_ALGOD_PORT,
  kmdPort = 4002,
  tealdbgPort = 9392,
): string {
  return `name: "${name}"

services:
  algod:
    container_name: "${name}_algod"
    image: ${ALGORAND_IMAGE}
    ports:
      - ${algodPort}:8080
      - ${kmdPort}:7833
      - ${tealdbgPort}:9392
    environment:
      START_KMD: 1
      KMD_TOKEN: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      TOKEN: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      ADMIN_TOKEN: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      GOSSIP_PORT: 10000
    init: true
    volumes:
      - type: bind
        source: ./algod_config.json
        target: /etc/algorand/config.json
      - type: bind
        source: ./algod_network_template.json
        target: /etc/algorand/template.json
      - ./goal_mount:/root/goal_mount

  conduit:
    container_name: "${name}_conduit"
    image: ${CONDUIT_IMAGE}
    restart: unless-stopped
    volumes:
      - type: bind
        source: ./conduit.yml
        target: /etc/algorand/conduit.yml
    depends_on:
      - indexer-db
      - algod

  indexer-db:
    container_name: "${name}_postgres"
    image: postgres:16-alpine
    ports:
      - 5443:5432
    user: postgres
    environment:
      POSTGRES_USER: algorand
      POSTGRES_PASSWORD: algorand
      POSTGRES_DB: indexerdb

  indexer:
    container_name: "${name}_indexer"
    image: ${INDEXER_IMAGE}
    ports:
      - 8980:8980
    restart: unless-stopped
    command: daemon --enable-all-parameters
    environment:
      INDEXER_POSTGRES_CONNECTION_STRING: "host=indexer-db port=5432 user=algorand password=algorand dbname=indexerdb sslmode=disable"
    depends_on:
      - conduit
`;
}
