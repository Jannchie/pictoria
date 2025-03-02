from dotenv import load_dotenv
from sqlalchemy import text

from utils import get_session

load_dotenv()
session = get_session()

sql = text("""DELETE FROM tags
WHERE name LIKE '%\\%';""")
session.execute(sql)
session.commit()
