FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution
RUN pip install uv

# Copy all source (pyproject.toml + app/) for non-editable install
COPY pyproject.toml .
COPY app/ app/

# Install package + dependencies
RUN uv pip install --system ".[firestore]"

# Create data directory for SQLite sessions + JSON game states
RUN mkdir -p /app/data/game_states

# Expose port
EXPOSE 8080

# Run with uvicorn — WebSocket max size 5MB, single worker (bidi state is in-memory)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--ws-max-size", "5242880"]
