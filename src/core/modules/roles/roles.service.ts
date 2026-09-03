import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RoleResponseDto } from './dto';

@Injectable()
export class RolesService {
  constructor(private prisma: PrismaService) {}

  async findAll(): Promise<RoleResponseDto[]> {
    const roles = await this.prisma.roles.findMany({
      include: {
        role_has_permissions: {
          include: {
            permissions: true
          }
        }
      },
      orderBy: {
        name: 'asc'
      }
    });

    return roles.map(role => ({
      id: Number(role.id),
      name: role.name,
      guard_name: role.guard_name,
      created_at: role.created_at,
      updated_at: role.updated_at,
      permissions: role.role_has_permissions.map(rhp => ({
        id: Number(rhp.permissions.id),
        name: rhp.permissions.name,
        guard_name: rhp.permissions.guard_name
      }))
    }));
  }

  async findOne(id: number): Promise<RoleResponseDto | null> {
    const role = await this.prisma.roles.findUnique({
      where: { id: BigInt(id) },
      include: {
        role_has_permissions: {
          include: {
            permissions: true
          }
        }
      }
    });

    if (!role) {
      return null;
    }

    return {
      id: Number(role.id),
      name: role.name,
      guard_name: role.guard_name,
      created_at: role.created_at,
      updated_at: role.updated_at,
      permissions: role.role_has_permissions.map(rhp => ({
        id: Number(rhp.permissions.id),
        name: rhp.permissions.name,
        guard_name: rhp.permissions.guard_name
      }))
    };
  }
}