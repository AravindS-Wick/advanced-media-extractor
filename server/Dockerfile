FROM python:3.10-slim

# Install system dependencies: curl, ffmpeg
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (to keep it fresh)
RUN pip install --no-cache-dir yt-dlp

# Set working directory
WORKDIR /app

# Copy the server source code
COPY server.py /app/server.py

# Expose port (Railway overrides this, but we declare it for completeness)
EXPOSE 8787

# Run the server script (binds to 0.0.0.0:PORT)
CMD ["python", "server.py"]
