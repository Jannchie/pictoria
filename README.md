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
    To run both the backend and frontend servers concurrently, use the following command from the project root:

    ```bash
    just dev
    ```

    Alternatively, you can run them separately:

    * **Backend Server:** `just server-dev`
    * **Frontend Server:** `just web-dev`
