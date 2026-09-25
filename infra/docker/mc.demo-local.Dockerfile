FROM alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507

ADD --checksum=sha256:a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318 \
    https://github.com/minio/mc/releases/download/RELEASE.2025-03-12T17-29-24Z/mc.linux-amd64.RELEASE.2025-03-12T17-29-24Z \
    /usr/local/bin/mc
RUN chmod 0755 /usr/local/bin/mc

ENTRYPOINT ["/usr/local/bin/mc"]
