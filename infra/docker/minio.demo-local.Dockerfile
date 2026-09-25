FROM alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507

ADD --checksum=sha256:5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6 \
    https://github.com/minio/minio/releases/download/RELEASE.2025-02-28T09-55-16Z/minio.linux-amd64.RELEASE.2025-02-28T09-55-16Z \
    /usr/local/bin/minio
RUN chmod 0755 /usr/local/bin/minio

ENTRYPOINT ["/usr/local/bin/minio"]
