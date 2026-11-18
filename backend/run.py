"""Start the Cutir backend:  python run.py   (from the backend folder or the project root: python backend/run.py)"""

import uvicorn

from app.config import settings
from app.main import app

if __name__ == "__main__":
    dist_ok = settings.dist.joinpath("index.html").is_file()
    print(f"Cutir backend on http://{settings.host}:{settings.port}")
    print(f"  aligner: {settings.aligner_backend}, model {settings.aligner_model}")
    print("  web app: " + ("served at / (from dist/)" if dist_ok else "not built (run `npm run build`, or use `npm run dev`)"))
    uvicorn.run(app, host=settings.host, port=settings.port)
