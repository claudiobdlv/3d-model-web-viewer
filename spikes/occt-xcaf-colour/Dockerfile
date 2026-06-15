FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    libfontconfig-dev \
    libocct-data-exchange-dev \
    libocct-foundation-dev \
    libocct-modeling-algorithms-dev \
    libocct-modeling-data-dev \
    libocct-ocaf-dev \
    libtbb-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work/spikes/occt-xcaf-colour

COPY CMakeLists.txt ./CMakeLists.txt
COPY src ./src

RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build --parallel

ENTRYPOINT ["/work/spikes/occt-xcaf-colour/build/occt-xcaf-report"]
