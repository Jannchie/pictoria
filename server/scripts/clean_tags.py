from dotenv import load_dotenv
from sqlalchemy import text

from utils import session

load_dotenv()
session = session()

sql = text("""DELETE FROM tags
WHERE name LIKE '%\\%';""")
session.execute(sql)
session.commit()
