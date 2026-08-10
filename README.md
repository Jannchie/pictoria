[![CodeTime Badge](https://shields.jannchie.com/endpoint?style=social&color=222&url=https%3A%2F%2Fapi.codetime.dev%2Fv3%2Fusers%2Fshield%3Fuid%3D2%26project%3Dpictoria)](https://codetime.dev)

# Pictoria

Pictoria is a full-stack image gallery application designed for managing and displaying images, with a focus on AI-generated art. It features a Python backend for serving images and data, and a Vue.js frontend for a rich user experience.

## Getting Started

### Prerequisites

* Python 3.12+ and `uv`
* Node.js and `pnpm`
* `just` command runner

### Installation & Running

1. **Clone the repository:**

    ```bash
    git clone git@github.com:Jannchie/pictoria.git
    cd pictoria
    ```

2. **Run the development environment:**
    One command from the project root starts all three processes — the API, the
    GPU worker and the frontend:

    ```bash
    pnpm dev
    ```

    Or run them separately:

    * **API (Hono, port 4777):** `pnpm dev:api`
    * **Worker (cairnq, owns the GPU):** `pnpm dev:worker`
    * **Frontend (Vite, port 4778):** `pnpm dev:web`
