export const db = open();
db.exec("PRAGMA journal_mode = WAL;");
const re = /x/; re.exec("x");
