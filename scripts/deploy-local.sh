#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pnpm_bin="${PNPM_BIN:-pnpm}"
hub_service_name="${DIFIT_HUB_SERVICE_NAME:-difit-hub.service}"
config_dir="${DIFIT_CONFIG_DIR:-${HOME}/.difit}"

skip_checks="${DIFIT_SKIP_CHECKS:-0}"
skip_build="${DIFIT_SKIP_BUILD:-0}"
no_restart="${DIFIT_NO_RESTART:-0}"

for arg in "$@"; do
    case "$arg" in
        --skip-checks) skip_checks=1 ;;
        --skip-build) skip_build=1 ;;
        --no-restart) no_restart=1 ;;
        -h|--help)
            cat << 'EOF'
Usage: ./scripts/deploy-local.sh [options]

Builds difit locally and reloads/restarts all active background services:
  - difit-hub.service (systemd user unit)
  - Active background difit review servers (ports 4966, 4967, etc.)
  - Idle difit MCP server bridge instances

Options:
  --skip-checks    Skip type-checking and unit tests before building
  --skip-build     Skip build step (only reload/restart processes)
  --no-restart     Build without restarting active review processes
  -h, --help       Show this help message

Environment:
  DIFIT_SKIP_CHECKS=1
  DIFIT_SKIP_BUILD=1
  DIFIT_NO_RESTART=1
  DIFIT_CONFIG_DIR=~/.difit
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

if ! command -v "${pnpm_bin}" >/dev/null 2>&1; then
    if command -v npm >/dev/null 2>&1; then
        pnpm_bin="npm"
    else
        echo "Error: pnpm (or npm) is required to build difit." >&2
        exit 1
    fi
fi

cd "${repo_root}"

if [[ "${skip_build}" != "1" ]]; then
    if [[ "${skip_checks}" != "1" ]]; then
        echo "==> Running checks..."
        "${pnpm_bin}" run check
        "${pnpm_bin}" run test
    else
        echo "==> Skipping checks (DIFIT_SKIP_CHECKS=1)"
    fi

    echo "==> Building difit..."
    "${pnpm_bin}" run build
    echo "==> Build complete."
fi

# Verify global difit resolves to repository
difit_bin="$(command -v difit 2>/dev/null || true)"
if [[ -n "${difit_bin}" ]]; then
    target="$(readlink -f "${difit_bin}" 2>/dev/null || true)"
    expected_dist="${repo_root}/dist/cli/index.js"
    if [[ "${target}" != "${expected_dist}" ]]; then
        echo "Notice: 'difit' in PATH (${difit_bin} -> ${target}) does not resolve to ${expected_dist}."
        echo "Linking local repository build to global node_modules..."
        npm link || true
    fi
fi

if [[ "${no_restart}" != "1" ]]; then
    # 1. Restart difit-hub.service if installed and active
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl --user is-active --quiet "${hub_service_name}" 2>/dev/null; then
            echo "==> Restarting ${hub_service_name}..."
            systemctl --user restart "${hub_service_name}"
            if systemctl --user is-active --quiet "${hub_service_name}"; then
                echo "    ${hub_service_name} restarted successfully."
            else
                echo "Warning: ${hub_service_name} failed to become active after restart." >&2
            fi
        fi
    fi

    # 2. Find and restart active review servers registered in ~/.difit/reviews/*.json
    reviews_dir="${config_dir}/reviews"
    restarted_count=0
    if [[ -d "${reviews_dir}" ]]; then
        for review_file in "${reviews_dir}"/*.json; do
            [[ -f "${review_file}" ]] || continue

            port="$(jq -r '.port // empty' "${review_file}" 2>/dev/null || true)"
            pid="$(jq -r '.pid // empty' "${review_file}" 2>/dev/null || true)"
            repo_path="$(jq -r '.repositoryPath // empty' "${review_file}" 2>/dev/null || true)"
            hapi_session="$(jq -r '.hapiSessionId // empty' "${review_file}" 2>/dev/null || true)"
            target_ref="$(jq -r '.targetRef // "."' "${review_file}" 2>/dev/null || echo ".")"

            [[ -n "${pid}" && -n "${port}" ]] || continue

            if kill -0 "${pid}" 2>/dev/null; then
                echo "==> Restarting review server on port ${port} (PID ${pid}, ${repo_path})..."

                cli_args=()
                cwd="${repo_path}"
                env_hapi="${hapi_session}"

                if [[ -d "/proc/${pid}" ]]; then
                    proc_cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
                    if [[ -n "${proc_cwd}" && -d "${proc_cwd}" ]]; then
                        cwd="${proc_cwd}"
                    fi

                    proc_hapi="$(tr '\0' '\n' < "/proc/${pid}/environ" 2>/dev/null | grep '^HAPI_SESSION_ID=' | cut -d= -f2- || true)"
                    if [[ -n "${proc_hapi}" ]]; then
                        env_hapi="${proc_hapi}"
                    fi

                    mapfile -d '' -t proc_args < "/proc/${pid}/cmdline" 2>/dev/null || proc_args=()
                    for ((i=2; i<${#proc_args[@]}; i++)); do
                        arg="${proc_args[i]}"
                        if [[ "${arg}" != "--background" && "${arg}" != "--keep-alive" && "${arg}" != "--no-open" ]]; then
                            cli_args+=("${arg}")
                        fi
                    done
                fi

                if [[ ${#cli_args[@]} -eq 0 ]]; then
                    cli_args=("${target_ref}" "--port" "${port}" "--include-untracked")
                fi

                has_port=0
                for a in "${cli_args[@]}"; do
                    if [[ "${a}" == "--port" || "${a}" == -p* ]]; then
                        has_port=1
                        break
                    fi
                done
                if [[ "${has_port}" -eq 0 && -n "${port}" ]]; then
                    cli_args+=("--port" "${port}")
                fi

                # Terminate old server process
                kill "${pid}" 2>/dev/null || true
                for _ in {1..30}; do
                    if ! kill -0 "${pid}" 2>/dev/null; then
                        break
                    fi
                    sleep 0.1
                done
                if kill -0 "${pid}" 2>/dev/null; then
                    kill -9 "${pid}" 2>/dev/null || true
                fi

                # Start new server in background
                if [[ -d "${cwd}" ]]; then
                    (
                        cd "${cwd}"
                        if [[ -n "${env_hapi}" ]]; then
                            export HAPI_SESSION_ID="${env_hapi}"
                        fi
                        difit "${cli_args[@]}" --background
                    )
                    restarted_count=$((restarted_count + 1))
                else
                    echo "Warning: Directory ${cwd} not found, cannot restart review on port ${port}." >&2
                fi
            fi
        done
    fi

    # 3. Refresh idle difit MCP processes
    mcp_pids="$(pgrep -f "node .*difit mcp" 2>/dev/null || true)"
    if [[ -n "${mcp_pids}" ]]; then
        echo "==> Refreshing idle difit MCP processes..."
        kill ${mcp_pids} 2>/dev/null || true
    fi

    echo "==> Deployment complete. Restarted ${restarted_count} review server(s)."
fi
