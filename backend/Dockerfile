FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency resolution
RUN pip install uv

# Copy dependency files first for layer caching
COPY pyproject.toml .

# Install dependencies
RUN uv pip install --system -e ".[firestore]"

# Copy application code
COPY app/ app/

# Expose port
EXPOSE 8080

# Run with uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
