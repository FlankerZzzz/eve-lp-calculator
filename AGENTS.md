# Deployment rules

- Release order is always: local build and tests, LAN deployment and visual confirmation, Git commit and push, then VPS `git pull` deployment.
- Do not deploy directly from local files to the VPS. The VPS must simulate a normal user installation by updating from Git with `git pull --ff-only`.
- Do not commit private network addresses, proxy addresses, hostnames, ports, credentials, or machine-local paths. Docker builds accept proxy values only through ignored local environment variables.
- Local and LAN builds use `BUILD_HTTP_PROXY` and `BUILD_HTTPS_PROXY` from an untracked `.env` file when required.
- VPS builds must leave both proxy variables empty.
- Never store passwords or private-key contents in the repository.
