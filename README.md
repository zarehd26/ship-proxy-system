# ShipShore Proxy System

A cost-efficient HTTP/S proxy system designed for cruise ships to minimize satellite internet charges by reusing a single persistent TCP connection for all outbound HTTP and HTTPS requests. This setup ensures that the satellite internet provider charges based on only one TCP connection regardless of the number of requests.

---

## Project Structure

shipshore/
├── client/
│ ├── ship-proxy.js # Ship proxy client implementation
│ ├── framing.js # TCP framing helpers (shared)
│ ├── Dockerfile # Dockerfile for client container
│ ├── package.json # Optional (for npm metadata)
├── server/
│ ├── offshore-proxy.js # Offshore proxy server implementation
│ ├── framing.js # TCP framing helpers (shared)
│ ├── Dockerfile # Dockerfile for server container
│ ├── package.json # Optional (for npm metadata)
├── docker-compose.yml # Compose file to run both containers
└── README.md # This file

---

## Key Features

- **Single TCP Connection Reuse**: All HTTP and HTTPS requests from the ship proxy client are sent sequentially over a single persistent TCP (or TLS) connection to the offshore proxy server.
- **Sequential Processing**: Requests are queued and processed one-by-one to ensure stability over satellite links.
- **Support for All HTTP Methods**: Including GET, POST, PUT, DELETE, and others.
- **HTTPS Support**: Proxy supports the HTTP CONNECT method to tunnel HTTPS traffic.
- **Automatic Reconnection**: The ship proxy client will attempt to reconnect to the offshore proxy server if the connection drops, seamlessly retrying queued requests.
- **Optional TLS**: The TCP channel between ship and offshore proxies can be secured by TLS using environment variables.
- **Cross-Platform Compatible**: Tested with curl on Windows, Linux, and macOS.

---

## Local Setup and Running

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Docker](https://www.docker.com/) (optional, for containerized deployment)
- [curl](https://curl.se/) (for testing)

---

### Running Without Docker

#### 1. Start Offshore Proxy Server

cd path/to/shipshore/server
node offshore-proxy.js

The server listens on port `9999` by default.

#### 2. Start Ship Proxy Client

Open a new terminal:

cd path/to/shipshore/client
node ship-proxy.js

The client listens on port `8080` by default and connects to the offshore server at `localhost:9999`.

#### 3. Test Proxy with curl

- **HTTP GET**

curl -x http://localhost:8080 http://example.com/

- **HTTPS GET**

curl -x http://localhost:8080 https://httpforever.com/

- **POST request**

curl -x http://localhost:8080 -X POST -d "sample data" http://httpforever.com/

- **Multiple Parallel Requests**

curl -x http://localhost:8080 http://example.com/ &
curl -x http://localhost:8080 http://example.com/ &
curl -x http://localhost:8080 http://example.com/ &
wait

---

### Enable Debug Logging

Set `DEBUG=true` environment variable before starting proxies for detailed logs:

On Unix/macOS:

DEBUG=true node ship-proxy.js
DEBUG=true node offshore-proxy.js

On Windows PowerShell:

$env:DEBUG="true"
node ship-proxy.js
node offshore-proxy.js

---

## Running with Docker Deployment

### Build Docker Images

From the `shipshore` root directory:

docker build -t yourdockerhubusername/offshore-proxy ./server
docker build -t yourdockerhubusername/ship-proxy ./client

---

### Run Docker Containers Locally

1. Run Offshore Proxy Server container:

docker run -p 9999:9999 yourdockerhubusername/offshore-proxy

2. Run Ship Proxy Client container:

docker run -p 8080:8080 -e OFFSHORE_HOST=host.docker.internal yourdockerhubusername/ship-proxy

---

### Using Docker Compose

Run both services together:

docker-compose up --build

---

## Configuration Environment Variables

| Variable       | Description                                   | Default       |
|----------------|-----------------------------------------------|---------------|
| OFFSHORE_HOST  | Hostname or IP of offshore proxy server       | localhost     |
| OFFSHORE_PORT  | Port of offshore proxy server                  | 9999          |
| LOCAL_PORT     | Port the ship proxy client listens on         | 8080          |
| USE_TLS        | Enable TLS on TCP connection (true/false)    | false         |
| DEBUG          | Enable debug logging (true/false)              | false         |
| TLS_CERT_PATH  | Path to TLS certificate (offshore server only) | (none)        |
| TLS_KEY_PATH   | Path to TLS private key (offshore server only) | (none)        |

---

## Important Notes

- This system strictly reuses **only one TCP or TLS connection** between ship and offshore proxies to minimize satellite link costs.
- Request processing is **sequential**; expect increased latency under heavy load.
- For production, add TLS or VPN and secure handling of certificates.
- Windows users must run tests with `curl.exe`, not PowerShell's alias.
- Make sure Docker host ports (`8080`, `9999`) are free before binding containers.

---

## Troubleshooting

- If experiencing repeated reconnect cycles, check offshore proxy server logs for errors or unexpected disconnects.
- Use the `DEBUG=true` flag for extensive logs.
- Confirm network/firewall allows port access.
- Validate framing protocol integrity by comparing logs on client and server.

---

## Contributing

Contributions and improvements welcome! Please open issues or pull requests on this repository.

---
