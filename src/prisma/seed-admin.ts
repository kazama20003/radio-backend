import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';
import { PrismaClient, Role } from '../generated/prisma/client';

/**
 * Crea (o actualiza) un único usuario ADMIN para poder entrar a la app y
 * administrar el resto. Credenciales por variables de entorno:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME  (con valores por defecto).
 * Idempotente: si el correo ya existe, lo deja como ADMIN activo y actualiza
 * la contraseña.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const email = (process.env.ADMIN_EMAIL || 'admin@syemape.com').toLowerCase();
  const plain = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Administrador';
  const passwordHash = await bcrypt.hash(plain, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { role: Role.ADMIN, isActive: true, passwordHash, name },
    create: { email, name, role: Role.ADMIN, isActive: true, passwordHash },
    select: { id: true, email: true, role: true },
  });

  console.log('✔ Admin listo:', user.email, `(rol ${user.role})`);
  console.log('  Contraseña:', plain, '— cámbiala después de entrar.');
}

main()
  .catch((e) => {
    console.error('Error creando admin:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
